"""Terminal commands and a configurable, read-only Thunderbird alert watcher."""
from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import fcntl
import hashlib
import json
import logging
import os
from pathlib import Path
import subprocess
import sys
import time

def _profile():
    if os.environ.get('TBMAIL_PROFILE'):
        return os.environ['TBMAIL_PROFILE']
    found = sorted((Path.home() / 'Library/Thunderbird/Profiles').glob('*.default-release'))
    return str(found[0]) if found else ''


PROFILE = _profile()
TOOLSETS = ('mail', 'folders', 'compose', 'search', 'filters', 'accounts', 'admin')
STATE = Path(os.environ.get('TBMAIL_STATE_DIR', str(Path.home() / '.local/state/thunderdex')))
SEARCH_FIELDS = {'full_text', 'subject', 'author', 'recipients', 'body', 'folder_id',
                 'account_id', 'unread', 'flagged', 'junk', 'has_attachment', 'tags'}


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def emit(value):
    print(json.dumps(value, ensure_ascii=False, indent=2, default=str))


def load(path, default):
    return json.loads(path.read_text()) if path.exists() else default


def save(path, value):
    temporary = path.with_suffix('.tmp')
    with open(temporary, 'w', encoding='utf-8') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    temporary.replace(path)


class Tools:
    async def __aenter__(self):
        from tbmcp.bridge import Bridge
        from tbmcp.config import Settings
        from tbmcp.server import build_server
        self.bridge = Bridge(profile_hint=PROFILE)
        self.server = build_server(Settings(profile=PROFILE, toolsets=TOOLSETS), bridge=self.bridge)
        return self

    async def __aexit__(self, *args):
        from tbmcp.bridge import set_shared_bridge
        await self.bridge.close()
        set_shared_bridge(None)

    async def call(self, name, arguments=None):
        result = await self.server.call_tool(name, arguments or {})
        if getattr(result, 'is_error', False):
            raise RuntimeError(str(result.content))
        value = getattr(result, 'structured_content', None)
        if value is None:
            raise RuntimeError(f'{name}: no structured result: {result}')
        return value


def read_json(value):
    if value == '-':
        return json.load(sys.stdin)
    if value.startswith('@'):
        return json.loads(Path(value[1:]).read_text())
    return json.loads(value)


def fingerprint(message):
    # Thunderbird's numeric IDs change after a restart; never deduplicate on those.
    identity = message.get('headerMessageId') or [
        message.get(k) for k in ('date', 'author', 'subject', 'folderId')]
    return hashlib.sha256(json.dumps(identity, ensure_ascii=False).encode()).hexdigest()


def notify(name, count):
    # Mail content is data passed as argv, never interpolated into AppleScript.
    script = ('on run argv\n'
              'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"\n'
              'end run')
    subprocess.run(['/usr/bin/osascript', '-e', script, 'Thunderbird : ' + name,
                    f'{count} nouveau(x) mail(s) correspondant à cette alerte.'],
                   capture_output=True, text=True, timeout=15, check=True)


async def scan(rules, state, tools):
    """Checkpoint only a completed paginated search; preserve errors per rule."""
    alerts, errors = [], []
    for rule in rules:
        start = now()
        previous = state.get(rule['name'], {})
        seen = dict(previous.get('seen', {}))
        since = dt.datetime.fromisoformat(rule['created_at'])
        if previous.get('last_success'):
            overlap = dt.datetime.fromisoformat(previous['last_success']) - dt.timedelta(days=1)
            since = max(since, overlap)
        arguments = {**rule['search'], 'from_date': since.isoformat(), 'limit': 200}
        cursor, cursors = None, set()
        found = []
        try:
            for _ in range(100):
                if cursor:
                    arguments['cursor'] = cursor
                result = await tools.call('mail_search', arguments)
                for message in result.get('items', []):
                    key = fingerprint(message)
                    if key not in seen:
                        found.append({'detected_at': start, 'rule': rule['name'], **message})
                    seen[key] = start
                cursor = result.get('nextCursor')
                if not cursor:
                    break
                if cursor in cursors:
                    raise RuntimeError('La pagination ne progresse plus.')
                cursors.add(cursor)
            else:
                raise RuntimeError('Plus de 20 000 correspondances : affiner cette règle.')
        except Exception as exc:
            # Do not advance this rule or emit a partial search as a complete one.
            errors.append({'rule': rule['name'], 'error': str(exc)})
            continue
        cutoff = (dt.datetime.fromisoformat(start) - dt.timedelta(days=2)).isoformat()
        state[rule['name']] = {'last_success': start,
                              'seen': {k: v for k, v in seen.items() if v >= cutoff}}
        alerts.extend(found)
    return alerts, errors


async def alerts_command(args):
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(STATE / 'alerts.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = STATE / 'rules.json'
        rules = load(path, [])
        if args.action == 'list':
            emit(rules)
        elif args.action == 'add':
            query = read_json(args.search)
            if not isinstance(query, dict) or not query or set(query) - SEARCH_FIELDS:
                raise ValueError('Filtres JSON invalides. Champs : ' + ', '.join(sorted(SEARCH_FIELDS)))
            if any(r['name'] == args.name for r in rules):
                raise ValueError('Ce nom existe déjà ; retirer la règle avant de la remplacer.')
            # Validate against the actual MCP schema before persisting a rule.
            import jsonschema
            async with Tools() as tools:
                schemas = await tools.server.list_tools()
                schema = next(t.input_schema for t in schemas if t.name == 'mail_search')
                jsonschema.validate({**query, 'from_date': now(), 'limit': 200}, schema)
            rule = {'name': args.name, 'search': query, 'created_at': now()}
            rules.append(rule)
            save(path, rules)
            emit({'added': rule, 'monitoring': 'Contrôle chaque minute ; nouveaux messages uniquement.'})
        elif args.action == 'remove':
            remaining = [r for r in rules if r['name'] != args.name]
            if len(remaining) == len(rules):
                raise ValueError('Règle inconnue : ' + args.name)
            save(path, remaining)
            state_path = STATE / 'checkpoint.json'
            state = load(state_path, {})
            state.pop(args.name, None)
            save(state_path, state)
            emit({'removed': args.name})
        elif args.action == 'log':
            log = STATE / 'alerts.jsonl'
            lines = log.read_text().splitlines() if log.exists() else []
            for line in lines[-args.limit:]:
                emit(json.loads(line))
        elif args.action == 'check':
            if not rules:
                if not args.quiet:
                    emit({'rules': 0, 'alerts': [], 'message': 'Aucun sujet configuré.'})
                return
            state_path = STATE / 'checkpoint.json'
            state = load(state_path, {})
            async with Tools() as tools:
                alerts, errors = await scan(rules, state, tools)
            if alerts:
                with open(STATE / 'alerts.jsonl', 'a', encoding='utf-8') as stream:
                    os.chmod(STATE / 'alerts.jsonl', 0o600)
                    for alert in alerts:
                        stream.write(json.dumps(alert, ensure_ascii=False) + '\n')
                if args.notify:
                    for name in dict.fromkeys(a['rule'] for a in alerts):
                        try:
                            notify(name, sum(a['rule'] == name for a in alerts))
                        except Exception as exc:
                            errors.append({'notification': name, 'error': str(exc),
                                           'message': 'Les alertes restent dans le journal.'})
            save(state_path, state)
            if alerts or errors or not args.quiet:
                emit({'checked_at': now(), 'rules': len(rules), 'alerts': alerts, 'errors': errors})
            if errors:
                raise RuntimeError('Échec partiel de la veille ; voir les erreurs ci-dessus.')


async def run(args):
    if args.command == 'alerts':
        return await alerts_command(args)
    async with Tools() as tools:
        cmd = args.command
        if cmd == 'tools':
            rows = await tools.server.list_tools()
            if args.name:
                emit(next(t.model_dump(mode='json', by_alias=True) for t in rows if t.name == args.name))
            else:
                emit([{'name': t.name, 'description': t.description.split('\n')[0]} for t in rows])
            return
        if cmd == 'call':
            name, parameters = args.name, read_json(args.arguments)
        elif cmd == 'status':
            result = await tools.call('tb_status')
            emit({k: result.get(k) for k in ('connected', 'addonVersion', 'app', 'missingFeatures')})
            return
        elif cmd == 'accounts':
            name, parameters = 'account_list', {'include_settings': False}
        elif cmd == 'inbox':
            folder = await tools.call('folder_get_unified', {'folder_type': 'inbox'})
            name, parameters = 'mail_list', {'folder_id': folder['id'], 'limit': args.limit}
        elif cmd == 'unread':
            name, parameters = 'mail_search', {'unread': True, 'junk': False, 'limit': args.limit}
        elif cmd == 'search':
            name, parameters = 'mail_search', {'full_text': args.query, 'limit': args.limit}
        elif cmd == 'read':
            name, parameters = 'mail_get', {'message_id': args.id}
        elif cmd == 'folders':
            name, parameters = 'folder_list', {'depth': 5, 'limit': 500}
        elif cmd == 'reply':
            body = Path(args.body_file).read_text() if args.body_file else args.body
            if args.send and not args.yes:
                raise ValueError('Pour envoyer, ajouter --yes après avoir relu le texte. Sans --send : brouillon.')
            name, parameters = 'mail_reply', {'message_id': args.id, 'body': body,
                                            'reply_all': args.all, 'mode': 'send' if args.send else 'draft',
                                            'confirm': True}
        elif cmd in ('archive', 'delete', 'move'):
            name, parameters = 'mail_' + cmd, {'message_ids': args.ids, 'confirm': True}
            if cmd == 'move':
                parameters['destination_folder_id'] = args.folder
            if cmd == 'delete':
                if args.permanent and not args.yes:
                    raise ValueError('Suppression définitive : --yes requis. Sans --permanent : corbeille.')
                parameters['permanent'] = args.permanent
        emit(await tools.call(name, parameters))


def parser():
    p = argparse.ArgumentParser(prog='tbmail', description='Thunderbird depuis le terminal. IDs à relire après chaque redémarrage.')
    sub = p.add_subparsers(dest='command', required=True)
    for cmd in ('status', 'accounts', 'folders'):
        sub.add_parser(cmd)
    for cmd in ('inbox', 'unread', 'search'):
        s = sub.add_parser(cmd)
        s.add_argument('--limit', type=int, default=25)
        if cmd == 'search':
            s.add_argument('query')
    s = sub.add_parser('read'); s.add_argument('id', type=int)
    s = sub.add_parser('reply'); s.add_argument('id', type=int)
    body = s.add_mutually_exclusive_group(required=True)
    body.add_argument('--body'); body.add_argument('--body-file')
    s.add_argument('--all', action='store_true'); s.add_argument('--send', action='store_true')
    s.add_argument('--yes', action='store_true')
    for cmd in ('archive', 'delete', 'move'):
        s = sub.add_parser(cmd); s.add_argument('ids', type=int, nargs='+')
        if cmd == 'delete':
            s.add_argument('--permanent', action='store_true'); s.add_argument('--yes', action='store_true')
        if cmd == 'move':
            s.add_argument('--folder', required=True)
    s = sub.add_parser('call'); s.add_argument('name'); s.add_argument('arguments', nargs='?', default='{}')
    s = sub.add_parser('tools'); s.add_argument('name', nargs='?')
    s = sub.add_parser('alerts'); a = s.add_subparsers(dest='action', required=True)
    a.add_parser('list')
    add = a.add_parser('add'); add.add_argument('name')
    add.add_argument('--search', required=True, help='Filtres mail_search en JSON, @fichier ou - pour stdin.')
    remove = a.add_parser('remove'); remove.add_argument('name')
    check = a.add_parser('check'); check.add_argument('--notify', action='store_true')
    check.add_argument('--quiet', action='store_true')
    log = a.add_parser('log'); log.add_argument('--limit', type=int, default=20)
    return p


if __name__ == '__main__':
    os.umask(0o077)
    logging.basicConfig(level=logging.WARNING)
    try:
        asyncio.run(run(parser().parse_args()))
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as exc:
        print(f'tbmail : {exc}', file=sys.stderr)
        sys.exit(1)
