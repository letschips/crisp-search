(async () => {
 const live=app.plugins.plugins['crisp-search'];
 const result={version:live.manifest.version,checks:[],benchmarks:[]};
 const check=(name,expected,actual)=>result.checks.push({name,expected,actual,pass:JSON.stringify(expected)===JSON.stringify(actual)});
 // Failure modes, written before changes: late create-read after stop/unload can repopulate
 // the index; exclusion during a pending read can leak a result; progress can reset scroll.
 // Use an isolated plugin instance and memory-only files; never change real licence or notes.
 for(const scenario of ['stop','unload','exclude']) {
  const template=app.vault.getMarkdownFiles()[0];
  const file=Object.assign(Object.create(Object.getPrototypeOf(template)),{path:'probe.md',basename:'probe',extension:'md'});
  let resolve; let ignored=false;
  const isolatedApp={vault:{cachedRead:()=>new Promise(r=>resolve=r),getAbstractFileByPath:()=>file},metadataCache:{isUserIgnored:()=>ignored,getFileCache:()=>null}};
  const p=new live.constructor(isolatedApp,{...live.manifest});
  p.indexStarted=true;
  p.onFileEvent(file);
  if(scenario==='stop') p.stopIndex();
  if(scenario==='unload') p.onunload();
  if(scenario==='exclude') ignored=true;
  resolve('probe marker');
  await new Promise(r=>setTimeout(r,0));
  check('pending read after '+scenario,0,p.engine.size);
 }
 const input=document.querySelector('.crisp-search-input');
 if(input) {
  input.value='Crisp'; input.dispatchEvent(new Event('input',{bubbles:true}));
  const list=document.querySelector('.crisp-search-list');
  list.scrollTop=200;
  live.emitProgress();
  check('progress keeps scroll with first row selected',200,list.scrollTop);
 }
 const engine=new live.engine.constructor();
 const content=('launcher alignment journal\n').repeat(4000)+'launcher needle\n';
 for(let i=0;i<20;i++) engine.upsert({path:`sample${i}.md`,basename:`sample${i}`,extension:'md',content,headings:[],tags:[],aliases:[]});
 for(const q of ['launchr needle','launcher needle']) {
  const times=[];let rows;
  for(let i=0;i<3;i++){const start=performance.now(); rows=engine.search(q);times.push(performance.now()-start)}
  result.benchmarks.push({query:q,timesMs:times,medianMs:[...times].sort((a,b)=>a-b)[1],count:rows.length,line:rows[0]?.line});
 }
 return JSON.stringify(result);
})()
