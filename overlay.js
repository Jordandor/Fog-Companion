const $=selector=>document.querySelector(selector);
let state={settings:{}};
let selectedKiller=null;
let rotation=0;
let spinning=false;
const colors=["#8c2229","#292a30","#641c22","#34353c","#a12830","#25262c"];
function showKillerPortrait(killer){let portrait=document.querySelector(".overlay-result-portrait");if(!portrait){portrait=document.createElement("div");portrait.className="overlay-result-portrait mystery";portrait.innerHTML='<span>?</span><img alt="">';document.querySelector(".result-panel").prepend(portrait)}const image=portrait.querySelector("img"),fallback=portrait.querySelector("span");image.onload=()=>{image.hidden=false;portrait.classList.remove("portrait-error")};image.onerror=()=>{image.hidden=true;fallback.textContent=killer?.name?.slice(0,1)||"?";portrait.classList.add("portrait-error")};if(killer){portrait.classList.remove("mystery","portrait-error");fallback.textContent=killer.name?.slice(0,1)||"?";image.hidden=false;image.src=killer.image||"";image.alt=killer.name}else{portrait.classList.add("mystery");portrait.classList.remove("portrait-error");fallback.textContent="?";image.hidden=false;image.removeAttribute("src");image.alt=""}}

function randomIndex(max){const values=new Uint32Array(1),limit=0xffffffff-(0xffffffff%max);do{crypto.getRandomValues(values)}while(values[0]>=limit);return values[0]%max}

function drawWheel(){
  const canvas=$("#overlayWheel"),context=canvas.getContext("2d"),killers=window.FOG_KILLERS,size=760,center=size/2,radius=center-15,arc=Math.PI*2/killers.length;
  context.clearRect(0,0,size,size);
  killers.forEach((killer,index)=>{
    const start=rotation+index*arc-Math.PI/2;
    context.beginPath();context.moveTo(center,center);context.arc(center,center,radius,start,start+arc);context.closePath();
    context.fillStyle=colors[index%colors.length];context.fill();context.strokeStyle="rgba(255,255,255,.12)";context.lineWidth=1.6;context.stroke();
    context.save();context.translate(center,center);context.rotate(start+arc/2);context.textAlign="right";context.textBaseline="middle";context.fillStyle="#eee9e5";context.font="18px Segoe UI";
    const label=killer.name.length>12?killer.name.slice(0,11)+"…":killer.name;context.fillText(label.toUpperCase(),radius-20,0);context.restore();
  });
  context.beginPath();context.arc(center,center,radius,0,Math.PI*2);context.strokeStyle="#aaa39e";context.lineWidth=4;context.stroke();
}

function spin(){
  if(spinning)return;
  const killers=window.FOG_KILLERS,winner=randomIndex(killers.length),arc=Math.PI*2/killers.length,start=rotation,normalized=((start%(Math.PI*2))+Math.PI*2)%(Math.PI*2),target=-winner*arc-arc/2;
  const delta=((target-normalized)%(Math.PI*2)+Math.PI*2)%(Math.PI*2)+(7+randomIndex(3))*Math.PI*2,duration=4000,started=performance.now();
  spinning=true;selectedKiller=null;showKillerPortrait(null);$(".overlay-shell").classList.add("busy");$("#overlaySpin").disabled=true;$("#overlayPick").disabled=true;$("#overlayAgain").disabled=true;$("#overlayResult").textContent="Колесо решает…";
  function frame(now){const progress=Math.min(1,(now-started)/duration),eased=1-Math.pow(1-progress,4);rotation=start+delta*eased;drawWheel();if(progress<1)requestAnimationFrame(frame);else{rotation=target;drawWheel();spinning=false;selectedKiller=killers[winner];showKillerPortrait(selectedKiller);$(".overlay-shell").classList.remove("busy");$("#overlaySpin").disabled=false;$("#overlayPick").disabled=false;$("#overlayAgain").disabled=false;$("#overlayResult").textContent=selectedKiller.name;$("#overlayStatus").textContent=state.settings?.automationEnabled?"Автовыбор настроен — можно перейти в DBD.":"Убийца выбран. Автовыбор настраивается в большом окне.";}}
  requestAnimationFrame(frame);
}

async function selectInGame(){
  if(!selectedKiller)return;
  const settings=state.settings||{};
  try{$("#overlayPick").disabled=true;$("#overlayStatus").textContent="Переключаюсь в Dead by Daylight…";await window.fogAPI.selectKiller({killer:selectedKiller,openPoint:settings.openPoint,searchPoint:settings.searchPoint,resultPoint:settings.resultPoint});window.fogAPI.hideOverlay();}
  catch(error){$("#overlayStatus").textContent=String(error.message||"Не удалось выбрать убийцу").replace(/^Error invoking remote method '[^']+': Error:\s*/,"");$("#overlayPick").disabled=false;}
}

$("#closeOverlay").onclick=()=>window.fogAPI.hideOverlay();
$("#overlaySpin").onclick=spin;
$("#overlayAgain").onclick=spin;
$("#overlayPick").onclick=selectInGame;
window.addEventListener("keydown",event=>{if(event.code==="Space"){event.preventDefault();spin()}if(event.code==="Escape")window.fogAPI.hideOverlay()});
window.fogAPI.onOverlayShown(value=>{if(value)state=value});
(async()=>{state=await window.fogAPI.getData();showKillerPortrait(null);drawWheel()})();
