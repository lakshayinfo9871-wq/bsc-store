const SHELL_CACHE='bsc-shell-v2',API_CACHE='bsc-api-v1',IMG_CACHE='bsc-img-v1',SHELL_URLS=['/','/manifest.json'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(SHELL_CACHE).then(c=>c.addAll(SHELL_URLS)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>![SHELL_CACHE,API_CACHE,IMG_CACHE].includes(k)).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const {request}=e,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin)return;
  if(url.pathname==='/api/store'){e.respondWith(fetch(request).then(res=>{
    // FIX: Clone immediately (synchronously) before any async gap.
    // Calling res.clone() inside caches.open().then() is a race condition —
    // by the time that callback runs, the browser may have already started
    // consuming res's body, causing "Response body is already used".
    const clone=res.clone();
    caches.open(API_CACHE).then(c=>c.put(request,clone));
    return res;
  }).catch(async()=>{const cached=await caches.match(request);if(cached){const data=await cached.json();return new Response(JSON.stringify({...data,_offline:true}),{headers:{'Content-Type':'application/json'}});}return new Response(JSON.stringify({_offline:true,products:[],categories:[],settings:{}}),{headers:{'Content-Type':'application/json'}});}));return;}
  if(SHELL_URLS.includes(url.pathname)){e.respondWith(caches.match(request).then(c=>c||fetch(request)));return;}
  if(url.pathname.startsWith('/uploads/')||url.pathname.startsWith('/icons/')){e.respondWith(caches.open(IMG_CACHE).then(async c=>{const cached=await c.match(request);const fresh=fetch(request).then(res=>{const clone=res.clone();c.put(request,clone);return res;}).catch(()=>null);return cached||await fresh;}));return;}
  if(url.pathname.startsWith('/api/'))return;
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
