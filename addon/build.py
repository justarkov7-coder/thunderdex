import json
from pathlib import Path
import zipfile
ROOT=Path(__file__).resolve().parent
out=ROOT.parent/'dist'/'thunderdex.xpi'
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
    for name in ['manifest.json','schema.json','background.js','api.js','dashboard.html','dashboard.css','dashboard.js','icon.svg']:
        if name=='api.js':
            z.writestr(name,(ROOT/name).read_text()+'\n'+(ROOT/'tag-rows.js').read_text()+'\n'+(ROOT/'folder-labels.js').read_text())
        else:
            z.write(ROOT/name,name)
out.chmod(0o600)
print(json.dumps({'package':str(out),'bytes':out.stat().st_size,'version':json.loads((ROOT/'manifest.json').read_text())['version']}))
