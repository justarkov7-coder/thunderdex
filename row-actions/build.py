"""Build dist/thunderdex-row-actions.xpi (archive-action.js is inlined before api.js)."""
from pathlib import Path
import zipfile
ROOT = Path(__file__).resolve().parent
out = ROOT.parent / 'dist' / 'thunderdex-row-actions.xpi'
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for name in ('manifest.json', 'background.js', 'schema.json'):
        z.write(ROOT / name, name)
    z.writestr('api.js', (ROOT / 'archive-action.js').read_text() + '\n' + (ROOT / 'api.js').read_text())
print(out)
