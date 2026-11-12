"""Build a private self-contained comparison from completed experiments and their original clock maps."""
import argparse,bisect,json,sqlite3
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--experiment',required=True);parser.add_argument('--database',required=True);parser.add_argument('--output',required=True);args=parser.parse_args()
folder=Path(args.experiment);plan=json.loads((folder/'plan.json').read_text());largest=max(plan['plans'],key=lambda p:p['durationMs']);sources=largest['sources'];start=min(s['recordedAt'] for s in sources);end=max(s['recordedAt']+s['durationMs'] for s in sources)
main=sqlite3.connect('file:'+args.database+'?mode=ro',uri=True);experiment=sqlite3.connect('file:'+str(folder/'evaluation.sqlite')+'?mode=ro',uri=True)
versions=[]
coverage=[[s['recordedAt'],s['recordedAt']+s['durationMs']] for s in sources]
rows=main.execute("SELECT begin_at,end_at,text,speaker,data FROM words WHERE owner='local' AND begin_at>=? AND begin_at<? ORDER BY begin_at,seq",(start,end)).fetchall()
versions.append({'label':'10 分钟分批','minutes':10,'from':start,'to':end,'coverage':coverage,'words':[[a,b,text,speaker,json.loads(data).get('speakerSource')=='voiceprint'] for a,b,text,speaker,data in rows]})
for p in plan['plans']:
 row=experiment.execute('SELECT state,input FROM jobs WHERE source_id=?',(p['id'],)).fetchone()
 if not row or row[0]!='completed':raise RuntimeError('Experiment is not complete; refusing to present missing results as empty speech')
 job_input=json.loads(row[1]);mapped=[]
 if job_input.get('sources'):
  ids=[item['sourceId'] for item in p['sources']]
  query="SELECT begin_at,end_at,text,speaker,data FROM words WHERE owner='evaluation' AND source_id IN ("+','.join('?' for _ in ids)+") ORDER BY begin_at,seq"
  for a,b,text,speaker,raw in experiment.execute(query,ids):mapped.append([a,b,text,speaker,json.loads(raw).get('speakerSource')=='voiceprint'])
 else:
  offsets=[item['offsetMs'] for item in p['sources']]
  for (raw,) in experiment.execute("SELECT data FROM words WHERE owner='evaluation' AND source_id=? ORDER BY begin_at,seq",(p['id'],)):
   word=json.loads(raw);i=bisect.bisect_right(offsets,word['startMs'])-1
   if i<0:raise RuntimeError('Timestamp before source map')
   source=p['sources'][i]
   if word['startMs']>source['offsetMs']+source['durationMs']:raise RuntimeError('Timestamp outside source map')
   clock=source['recordedAt']-source['offsetMs'];mapped.append([clock+word['startMs'],clock+word['endMs'],word['text'],word['speaker'],word.get('speakerSource')=='voiceprint'])
 versions.append({'label':f"{p['hours']} 小时合并",'minutes':p['durationMs']/60000,'from':min(s['recordedAt'] for s in p['sources']),'to':max(s['recordedAt']+s['durationMs'] for s in p['sources']),'coverage':[[s['recordedAt'],s['recordedAt']+s['durationMs']] for s in p['sources']],'words':mapped})
payload={'from':start,'to':end,'target':plan['target'],'versions':versions}
template=Path(__file__).resolve().parent.parent/'report/transcription-comparison.html'
encoded=json.dumps(payload,ensure_ascii=False,separators=(',',':')).replace('<','\\u003c')
comparison=[]
for version in versions:
 selected=[w for w in version['words'] if plan['target']['fromMS']-500<=w[0]<plan['target']['toMS']+500]
 comparison.append({'version':version['label'],'minutes':version['minutes'],'text':''.join(w[2] for w in selected),'labels':sorted(set(w[3] or 'unknown' for w in selected)),'selfWords':sum(bool(w[4]) for w in selected)})
(folder/'comparison.json').write_text(json.dumps(comparison,ensure_ascii=False,indent=2))
out=Path(args.output);out.write_text(template.read_text().replace('__COMPARISON_DATA__',encoded));out.chmod(0o600)
print(json.dumps({'html':str(out),'versions':len(versions),'characters':[sum(len(w[2]) for w in v['words']) for v in versions]}))
