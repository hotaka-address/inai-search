const V="hs-v30",SHELL=["./","index.html","app.js","manifest.webmanifest","icon-180.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(SHELL.map(u=>new Request(u,{cache:"reload"})))).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==V).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{const u=new URL(e.request.url);
 if(e.request.method!=="GET")return;
 if(u.origin===location.origin||u.hostname==="cdnjs.cloudflare.com"){
  e.respondWith(fetch(e.request,{cache:"no-cache"}).then(r=>{if(r.ok){const cp=r.clone();caches.open(V).then(c=>c.put(e.request,cp))}return r}).catch(()=>caches.match(e.request)))}});
