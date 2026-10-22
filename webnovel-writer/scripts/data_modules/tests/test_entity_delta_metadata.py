"""Regression coverage for payload metadata and partial entity updates (issue #201)."""

import json

import pytest

from data_modules.chapter_commit_service import ChapterCommitService
from data_modules.config import DataModulesConfig
from data_modules.index_manager import IndexManager
from data_modules.index_projection_writer import IndexProjectionWriter
from data_modules.state_projection_writer import StateProjectionWriter


def _commit(chapter, delta, state_deltas=None):
    return {
        "meta": {"status": "accepted", "chapter": chapter},
        "extraction_result": {
            "accepted_events": [],
            "state_deltas": state_deltas or [],
            "entity_deltas": [{"chapter": chapter, **delta}],
        },
    }


@pytest.fixture
def manager(tmp_path):
    config = DataModulesConfig.from_project_root(tmp_path)
    config.ensure_dirs()
    return IndexManager(config)


@pytest.mark.parametrize("desc_key", ["desc", "description"])
def test_index_projection_reads_payload_metadata(tmp_path, manager, desc_key):
    commit = _commit(1, {
        "entity_id": "hong_bagong",
        "action": "upsert",
        "entity_type": "角色",
        "payload": {"name": "洪八公", desc_key: "重要配角", "tier": "重要"},
    })
    IndexProjectionWriter(tmp_path).apply(commit)

    entity = manager.get_entity("hong_bagong")
    assert entity["canonical_name"] == "洪八公"
    assert entity["desc"] == "重要配角"
    assert entity["tier"] == "重要"
    assert [row["id"] for row in manager.get_core_entities()] == ["hong_bagong"]

    commit["extraction_result"]["entity_deltas"][0]["payload"]["is_archived"] = True
    IndexProjectionWriter(tmp_path).apply(commit)
    assert manager.get_entity("hong_bagong")["is_archived"] == 1
    assert manager.get_core_entities() == []


def test_sparse_delta_preserves_existing_metadata_and_merges_current(manager):
    manager.apply_entity_delta({
        "entity_id": "qingyun_zong", "chapter": 1, "entity_type": "组织",
        "canonical_name": "青云宗", "tier": "重要", "desc": "已有描述",
        "is_protagonist": True, "is_archived": True, "current": {"realm": "斗者"},
    })
    manager.apply_entity_delta({
        "entity_id": "qingyun_zong", "chapter": 2, "current": {"location": "山门"},
    })

    entity = manager.get_entity("qingyun_zong")
    assert entity["canonical_name"] == "青云宗"
    assert entity["type"] == "组织"
    assert entity["tier"] == "重要"
    assert entity["desc"] == "已有描述"
    assert entity["is_protagonist"] == 1
    assert entity["is_archived"] == 1
    assert entity["current_json"] == {"realm": "斗者", "location": "山门"}
    assert entity["first_appearance"] == 1
    assert entity["last_appearance"] == 2


def test_top_level_aliases_take_precedence_over_payload(manager):
    manager.apply_entity_delta({
        "entity_id": "hero", "entity_type": "组织", "name": "顶层名称",
        "description": "顶层描述", "tier": "次要",
        "is_protagonist": False, "is_archived": False,
        "payload": {
            "canonical_name": "嵌套名称", "type": "角色", "desc": "嵌套描述",
            "tier": "主角", "is_protagonist": True, "is_archived": True,
        },
    })

    entity = manager.get_entity("hero")
    assert entity["canonical_name"] == "顶层名称"
    assert entity["type"] == "组织"
    assert entity["desc"] == "顶层描述"
    assert entity["tier"] == "次要"
    assert entity["is_protagonist"] == 0
    assert entity["is_archived"] == 0


@pytest.mark.parametrize("nested", [False, True])
@pytest.mark.parametrize("desc", ["", None])
def test_explicit_empty_description_and_false_flags_clear_existing_values(manager, nested, desc):
    manager.apply_entity_delta({
        "entity_id": "hero", "tier": "主角", "desc": "旧描述", "is_archived": True,
    })
    metadata = {"desc": desc, "is_protagonist": False, "is_archived": False}
    manager.apply_entity_delta({"entity_id": "hero", **({"payload": metadata} if nested else metadata)})

    entity = manager.get_entity("hero")
    assert entity["desc"] == ""
    assert entity["tier"] == "主角"
    assert entity["is_protagonist"] == 0
    assert entity["is_archived"] == 0


@pytest.mark.parametrize("metadata", [{"is_protagonist": True}, {"tier": "主角"}])
def test_payload_protagonist_signal_reaches_both_projections(tmp_path, manager, metadata):
    commit = _commit(1, {
        "entity_id": "hero", "entity_type": "角色",
        "payload": {"canonical_name": "陆鸣", **metadata},
    }, [{"entity_id": "hero", "field": "power.realm", "new": "练气五层"}])
    IndexProjectionWriter(tmp_path).apply(commit)
    StateProjectionWriter(tmp_path).apply(commit)

    assert manager.get_protagonist()["canonical_name"] == "陆鸣"
    state = json.loads((tmp_path / ".webnovel/state.json").read_text(encoding="utf-8"))
    assert state["protagonist_state"]["power"]["realm"] == "练气五层"


@pytest.mark.parametrize("nested", [False, True])
def test_state_projection_respects_explicit_false_protagonist(tmp_path, nested):
    state_path = tmp_path / ".webnovel/state.json"
    state_path.parent.mkdir()
    state_path.write_text(json.dumps({
        "protagonist_state": {"entity_id": "hero", "name": "陆鸣", "power": {"realm": "旧境界"}},
    }), encoding="utf-8")
    metadata = {"is_protagonist": False, "tier": "主角", "name": "陆鸣"}
    delta = {"entity_id": "hero", **({"payload": metadata} if nested else metadata)}
    StateProjectionWriter(tmp_path).apply(_commit(2, delta, [
        {"entity_id": "hero", "field": "power.realm", "new": "新境界"},
    ]))

    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state["entity_state"]["hero"]["power"]["realm"] == "新境界"
    assert state["protagonist_state"]["power"]["realm"] == "旧境界"


def test_chapter_commit_and_projection_replay_preserve_payload_metadata(tmp_path, manager):
    service = ChapterCommitService(tmp_path)
    commits = []
    for chapter, payload in [(1, {"name": "洪八公", "tier": "重要", "desc": "重要配角"}),
                             (2, {"name": "洪八公"})]:
        commit = service.build_commit(
            chapter=chapter,
            review_result={"blocking_count": 0},
            fulfillment_result={"planned_nodes": [], "covered_nodes": [], "missed_nodes": [], "extra_nodes": []},
            disambiguation_result={"pending": []},
            extraction_result=_commit(chapter, {
                "entity_id": "hong_bagong", "action": "upsert", "entity_type": "角色", "payload": payload,
            })["extraction_result"],
        )
        assert commit["meta"]["status"] == "accepted"
        service.apply_projections(commit)
        commits.append(commit)

    for commit in commits:
        service.apply_projections(commit)
    entity = manager.get_entity("hong_bagong")
    assert entity["tier"] == "重要"
    assert entity["desc"] == "重要配角"
    assert entity["last_appearance"] == 2
