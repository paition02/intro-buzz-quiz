// A controllable SDK boundary for production-controller tests, not an audio
// emulator or evidence about the real MusicKit SDK. Real SDK tests are separate.
(() => {
  const calls=[], outcomes={}, gates={}, listeners=new Map(), faults={}, events=[];
  let position=0, started=0, playing=false;
  const emit=(event,payload={})=>{
    events.push({event,payload,at:performance.now(),volume:mk.volume,id:mk.nowPlayingItem?.id});
    listeners.get(event)?.forEach(fn=>fn(payload));
  };
  const mk={
    volume:1, isAuthorized:true, storefrontId:'us', repeatMode:0,
    queue:{items:[]}, nowPlayingItem:null, nowPlayingItemIndex:0,
    get isPlaying(){return playing},
    get currentPlaybackTime(){return position+(playing ? (performance.now()-started)/1000 : 0)},
    addEventListener(event,fn){if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event).add(fn)},
    removeEventListener(event,fn){listeners.get(event)?.delete(fn)},
  };
  const raw={
    async setQueue(options){mk.queue.items=[{id:options.song ?? options.album}];mk.nowPlayingItem=mk.queue.items[0];mk.nowPlayingItemIndex=0;position=0;playing=false;},
    async play(){if(!playing){started=performance.now();playing=true;emit('playbackStateDidChange',{state:2});}},
    async pause(){position=mk.currentPlaybackTime;playing=false;emit('playbackStateDidChange',{state:3});},
    async seekToTime(value){position=value;started=performance.now();},
    async playNext(options){mk.queue.items.push({id:options.song});},
    async skipToNextItem(){mk.nowPlayingItemIndex++;mk.nowPlayingItem=mk.queue.items[mk.nowPlayingItemIndex];position=0;started=performance.now();playing=true;},
    async authorize(){mk.isAuthorized=true;emit('authorizationStatusDidChange');},
    async unauthorize(){mk.isAuthorized=false;emit('authorizationStatusDidChange');},
    async music(url){
      if(window.sdk.responses[url])return {data:structuredClone(window.sdk.responses[url])};
      if(url.includes('/playlists'))return {data:{data:[]}};
      return {data:{data:[{id:'album-A',relationships:{albums:{data:[{id:'album-A'}]}}}]}};
    },
  };
  for(const [method,fn] of Object.entries(raw)){
    const wrapped=async(...args)=>{
      const record={method,args,at:performance.now(),done:false};calls.push(record);
      const fault=faults[method]?.shift();
      if(fault?.before)await new Promise((resolve,reject)=>{gates[fault.name]={resolve,reject}});
      if(fault?.reject)throw new Error('Injected '+method+' failure');
      const result=await fn(...args);
      if(fault?.after)await new Promise((resolve,reject)=>{gates[fault.name]={resolve,reject}});
      record.done=true;return result;
    };
    if(method==='music')mk.api={music:wrapped};else mk[method]=wrapped;
  }
  window.sdk={mk,calls,outcomes,responses:{},emit,
    arm(method,name,stage='before'){(faults[method]??=[]).push({name,[stage]:true})},
    release(name,error){if(!gates[name])throw new Error('Missing gate '+name);if(error)gates[name].reject(new Error(error));else gates[name].resolve();delete gates[name]},
    gates:()=>Object.keys(gates),
    snapshot:()=>({calls,events,playing,position:mk.currentPlaybackTime,volume:mk.volume,id:mk.nowPlayingItem?.id,gates:Object.keys(gates),listeners:Object.fromEntries([...listeners].filter(([,v])=>v.size>0).map(([k,v])=>[k,v.size]))}),
  };
  window.MusicKit={configure:async()=>mk,getInstance:()=>mk,PlayerRepeatMode:{none:0,one:1,all:2},PlayerShuffleMode:{off:0}};
})();
