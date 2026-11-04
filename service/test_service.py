"""Scheduler/approval tests use an isolated temp directory and no model or mail."""
import datetime as dt
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
import server as mod

class FakeCodex:
    def __init__(self, app): self.messages=[];self.count=0;self.calls=[]
    def call(self, method, params=None, **_):
        self.calls.append((method,params))
        if method=='thread/start': self.count+=1;return {'thread':{'id':str(self.count)}}
        if method=='turn/start':return {'turn':{'id':'turn'}}
        if method=='account/read':return {'account':{'type':'chatgpt'}}
        return {}
    def write(self, message):self.messages.append(message)

class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.p=patch.multiple(mod,STATE=Path(self.tmp.name)/'state',Codex=FakeCodex,MAILBOXES=['a@example.com','b@example.com']);self.p.start();self.addCleanup(self.p.stop)
        n=patch.object(mod.Application,'notify',staticmethod(lambda *a:None));n.start();self.addCleanup(n.stop)
        self.app=mod.Application()
    def task(self,frequency='once'):
        return self.app.task_save({'name':'Test','prompt':'Répondre OK sans outils','frequency':frequency,'nextRun':time.time()+3600})['id']
    def test_single_claim_and_results(self):
        key=self.task();self.app.run_task(key)
        with self.assertRaises(ValueError):self.app.run_task(key)
        t=self.app.db['tasks'][key]
        self.app.event({'method':'item/completed','params':{'threadId':t['activeChat'],'item':{'type':'agentMessage','id':'a','text':'OK'}}})
        self.app.event({'method':'turn/completed','params':{'threadId':t['activeChat'],'turn':{'status':'completed'}}})
        self.assertFalse(t['running']);self.assertEqual(t['runs'][-1]['result'],'OK')
        self.assertEqual(len(t['runs']),1)
    def test_restart_does_not_retry_uncertain_run(self):
        key=self.task();self.app.run_task(key);other=mod.Application()
        self.assertEqual(other.db['tasks'][key]['lastStatus'],'interrupted');self.assertEqual(other.codex.count,0)
    def test_permissions_require_explicit_response(self):
        self.app.event({'id':15,'method':'item/permissions/requestApproval','params':{'permissions':{'network':{'enabled':True}}}})
        self.assertFalse(self.app.codex.messages)
        self.app.request('approval.reply',{'id':'15','decision':'decline'})
        self.assertEqual(self.app.codex.messages[-1]['result'],{'permissions':{},'scope':'turn'})
    def test_repeat_skips_missed_times(self):
        self.assertEqual(mod.next_run({'frequency':'interval','minutes':5,'nextRun':100},1000),1300)
        self.assertIsNone(mod.next_run({'frequency':'once','nextRun':100},1000))
    def test_daily_preserves_wall_clock_across_dst(self):
        old=dt.datetime(2027,3,27,9,0,tzinfo=mod.ZONE).timestamp()
        new=mod.next_run({'frequency':'daily','nextRun':old},old+1)
        self.assertEqual(dt.datetime.fromtimestamp(new,mod.ZONE).hour,9)
        self.assertEqual(new-old,23*3600)
    def test_private_state_and_invalid_dates(self):
        self.assertEqual(self.app.path.stat().st_mode&0o777,0o600)
        with self.assertRaises(ValueError):self.app.task_save({'name':'x','prompt':'x','frequency':'once','nextRun':float('nan')})
    def test_stream_delivers_deltas_without_state_polling(self):
        key=self.app.new_chat();sub=self.app.subscribe(key)
        self.assertEqual(sub.get_nowait()['kind'],'snapshot')
        self.app.event({'method':'item/agentMessage/delta','params':{'threadId':key,'itemId':'a','delta':'Bon'}})
        self.app.event({'method':'item/agentMessage/delta','params':{'threadId':key,'itemId':'a','delta':'jour'}})
        events=[sub.get_nowait(),sub.get_nowait()]
        self.assertEqual(''.join(v['text'] for v in events),'Bonjour')
        self.assertEqual([v['revision'] for v in events],[1,2])
        self.assertEqual(self.app.db['chats'][key]['messages'][0]['text'],'Bonjour')
        self.app.unsubscribe(key,sub);self.assertFalse(self.app.subscribers)
    def test_one_minute_and_read_mode_reach_the_execution(self):
        key=self.app.task_save({'name':'Minute','prompt':'Résumer','frequency':'interval','minutes':1,'nextRun':time.time()+3600,'accounts':['b@example.com'],'actions':{'mode':'read','send':True}})['id']
        self.app.run_task(key)
        start=next(p for method,p in self.app.codex.calls if method=='thread/start')
        self.assertIn('LECTURE SEULE',start['developerInstructions'])
        self.assertIn('b@example.com',start['developerInstructions'])
        self.assertNotIn('a@example.com',start['developerInstructions'])
        self.assertFalse(self.app.db['tasks'][key]['actions']['send'])
        self.assertEqual(self.app.state()['chats'][0]['origin'],'planned')
    def test_schedule_skips_weekend_and_closed_hours(self):
        options=mod.schedule_options({'days':[0,1,2,3,4],'window':{'enabled':True,'start':'09:00','end':'18:00'}})
        friday=dt.datetime(2026,11,6,18,1,tzinfo=mod.ZONE).timestamp()
        expected=dt.datetime(2026,11,9,9,0,tzinfo=mod.ZONE).timestamp()
        self.assertEqual(mod.eligible_time(friday,options),expected)
    def test_overnight_window_and_end_date(self):
        options=mod.schedule_options({'days':[0],'window':{'enabled':True,'start':'22:00','end':'06:00'}})
        tuesday=dt.datetime(2026,11,10,5,0,tzinfo=mod.ZONE).timestamp()
        self.assertEqual(mod.eligible_time(tuesday,options),tuesday)
        options['endDate']='2026-11-09'
        self.assertIsNone(mod.eligible_time(tuesday,options))
    def test_schedule_requires_day_and_send_requires_write_mode(self):
        with self.assertRaises(ValueError):mod.schedule_options({'days':[]})
        self.assertFalse(mod.action_options({'mode':'draft','send':True})['send'])
    def test_live_phase_uses_real_tool_lifecycle_without_arguments(self):
        key=self.app.new_chat();sub=self.app.subscribe(key);sub.get_nowait()
        self.app.event({'method':'item/started','params':{'threadId':key,'item':{'id':'tool1','type':'mcpToolCall','tool':'gmail_search_emails','server':'codex_apps','arguments':{'private':'do not show'}}}})
        event=sub.get_nowait();self.assertEqual(event['kind'],'status');self.assertEqual(event['phase'],'mcp')
        self.assertIn('gmail_search_emails',event['activity']);self.assertNotIn('private',json.dumps(event))
        self.app.event({'method':'item/completed','params':{'threadId':key,'item':{'id':'tool1','type':'mcpToolCall'}}})
        self.assertEqual(sub.get_nowait()['phase'],'thinking')
        self.app.event({'method':'item/agentMessage/delta','params':{'threadId':key,'itemId':'answer','delta':'OK'}})
        self.assertEqual(sub.get_nowait()['kind'],'delta')
        self.app.event({'method':'item/completed','params':{'threadId':key,'item':{'id':'answer','type':'agentMessage','text':'OK'}}})
        self.assertEqual(sub.get_nowait()['kind'],'message')
        self.app.event({'method':'turn/completed','params':{'threadId':key,'turn':{'status':'completed'}}})
        self.assertEqual(sub.get_nowait()['status'],'completed')

    def test_read_mode_exposes_only_read_tools(self):
        key=self.app.task_save({'name':'R','prompt':'Lire','frequency':'once','nextRun':time.time()+3600,'actions':{'mode':'read'}})['id']
        self.app.run_task(key)
        start=next(p for m,p in self.app.codex.calls if m=='thread/start')
        tools=start['config']['mcp_servers.thunderbird.enabled_tools']
        self.assertIn('mail_search',tools);self.assertNotIn('mail_send',tools);self.assertNotIn('mail_delete',tools);self.assertNotIn('mail_draft_save',tools)
    def test_write_mode_adds_only_granted_tools(self):
        tools=mod.tool_config(mod.action_options({'mode':'write','send':True,'trash':False}))['mcp_servers.thunderbird.enabled_tools']
        self.assertIn('mail_reply',tools);self.assertIn('mail_archive',tools);self.assertNotIn('mail_delete',tools)
    def test_stop_without_turn_is_a_clear_error(self):
        key=self.app.new_chat()
        with self.assertRaises(ValueError):self.app.request('chat.stop',{'id':key})

    def test_reboot_replays_read_only_run_once(self):
        key=self.task();self.app.run_task(key);other=mod.Application()
        self.assertTrue(other.db['tasks'][key]['retry'])
        key2=self.app.task_save({'name':'W','prompt':'x','frequency':'once','nextRun':time.time()+3600,'actions':{'mode':'write'}})['id']
        self.app.run_task(key2);third=mod.Application()
        self.assertFalse(third.db['tasks'][key2]['retry'])

if __name__=='__main__':unittest.main()
