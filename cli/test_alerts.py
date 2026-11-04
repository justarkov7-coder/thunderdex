import asyncio
import copy
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location('tbmail', Path(__file__).with_name('tbmail.py'))
tb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tb)

RULE = {'name': 'test', 'created_at': '2026-11-02T10:00:00+00:00', 'search': {'subject': 'test'}}


class FakeTools:
    def __init__(self, replies):
        self.replies = iter(replies)
        self.calls = []

    async def call(self, name, arguments):
        self.calls.append((name, dict(arguments)))
        reply = next(self.replies)
        if isinstance(reply, Exception):
            raise reply
        return reply


def test_pages_and_stable_dedup_after_thunderbird_restart():
    state = {}
    first = {'id': 2, 'headerMessageId': '<stable>', 'subject': 'test'}
    second = {'id': 3, 'headerMessageId': '<other>', 'subject': 'test'}
    client = FakeTools([{'items': [first], 'nextCursor': 'page2'}, {'items': [second]}])
    alerts, errors = asyncio.run(tb.scan([RULE], state, client))
    assert not errors and len(alerts) == 2
    assert client.calls[1][1]['cursor'] == 'page2'
    assert client.calls[0][1]['subject'] == 'test'
    restarted = FakeTools([{'items': [{**first, 'id': 200}, {**second, 'id': 300}]}])
    alerts, errors = asyncio.run(tb.scan([RULE], state, restarted))
    assert alerts == [] and errors == []


def test_failed_page_does_not_advance_checkpoint_or_emit_partial_results():
    state = {'test': {'last_success': '2026-11-02T10:01:00+00:00', 'seen': {}}}
    original = copy.deepcopy(state)
    tools = FakeTools([{'items': [{'headerMessageId': '<new>'}], 'nextCursor': 'next'},
                       RuntimeError('offline')])
    alerts, errors = asyncio.run(tb.scan([RULE], state, tools))
    assert alerts == [] and errors[0]['rule'] == 'test'
    assert state == original


def test_identical_message_in_several_folders_alerts_once():
    message = {'id': 1, 'headerMessageId': '<same>', 'folderId': 'inbox'}
    tools = FakeTools([{'items': [message, {**message, 'id': 9, 'folderId': 'archive'}]}])
    alerts, errors = asyncio.run(tb.scan([RULE], {}, tools))
    assert len(alerts) == 1 and not errors


def test_repeated_cursor_is_an_error_without_checkpoint():
    tools = FakeTools([{'items': [], 'nextCursor': 'same'}, {'items': [], 'nextCursor': 'same'}])
    state = {}
    alerts, errors = asyncio.run(tb.scan([RULE], state, tools))
    assert not alerts and errors and not state
