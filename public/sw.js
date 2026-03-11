const SHELL_CACHE='bsc-shell-v11',API_CACHE='bsc-api-v3',IMG_CACHE='bsc-img-v1';

self.addEventListener('install',e=>{e.waitUntil(self.skipWaiting());});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>![SHELL_CACHE,API_CACHE,IMG_CACHE].includes(k)).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});

self.addEventListener('fetch',e=>{
  const {request}=e,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin)return;

  // API store data: network-first, cache fallback
  if(url.pathname==='/api/store'){
    e.respondWith(fetch(request).then(res=>{
      const clone=res.clone();
      caches.open(API_CACHE).then(c=>c.put(request,clone));
      return res;
    }).catch(async()=>{
      const cached=await caches.match(request);
      if(cached){const data=await cached.json();return new Response(JSON.stringify({...data,_offline:true}),{headers:{'Content-Type':'application/json'}});}
      return new Response(JSON.stringify({_offline:true,products:[],categories:[],settings:{}}),{headers:{'Content-Type':'application/json'}});
    }));
    return;
  }

  // Main HTML — ALWAYS network-first, never serve stale shell.
  // Any update you deploy is seen immediately on next load.
  // Falls back to cache only if truly offline.
  if(url.pathname==='/'||url.pathname==='/index.html'){
    e.respondWith(fetch(request).then(res=>{
      const clone=res.clone();
      caches.open(SHELL_CACHE).then(c=>c.put(request,clone));
      return res;
    }).catch(()=>caches.match(request)));
    return;
  }

  // manifest.json: stale-while-revalidate
  if(url.pathname==='/manifest.json'){
    e.respondWith(caches.open(SHELL_CACHE).then(async c=>{
      const cached=await c.match(request);
      const fresh=fetch(request).then(res=>{c.put(request,res.clone());return res;}).catch(()=>null);
      return cached||await fresh;
    }));
    return;
  }

  // Images/icons: cache-first (rarely change)
  if(url.pathname.startsWith('/uploads/')||url.pathname.startsWith('/icons/')){
    e.respondWith(caches.open(IMG_CACHE).then(async c=>{
      const cached=await c.match(request);
      const fresh=fetch(request).then(res=>{c.put(request,res.clone());return res;}).catch(()=>null);
      return cached||await fresh;
    }));
    return;
  }

  // Other API calls: never cache
  if(url.pathname.startsWith('/api/'))return;

  // Everything else: network with cache fallback
  e.respondWith(fetch(request).catch(()=>caches.match(request)));
});

self.addEventListener('push',e=>{
  let data={title:'BSC Store',body:'New notification',url:'/',tag:'bsc-push'};
  if(e.data){try{Object.assign(data,JSON.parse(e.data.text()));}catch{data.body=e.data.text();}}
  e.waitUntil(self.registration.showNotification(data.title,{body:data.body,icon:'/icons/icon-192.png',badge:'/icons/icon-192.png',tag:data.tag,data:{url:data.url||'/'},vibrate:[200,100,200],actions:[{action:'open',title:'🛒 Open Store'},{action:'dismiss',title:'Dismiss'}]}));
});

self.addEventListener('notificationclick',e=>{
  e.notification.close();if(e.action==='dismiss')return;
  const url=e.notification.data?.url||'/';
  e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(all=>{for(const c of all){if(c.url.includes(self.location.origin)){c.focus();c.navigate(url);return;}}if(clients.openWindow)return clients.openWindow(url);}));
});
