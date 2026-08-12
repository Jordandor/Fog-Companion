const { app, BrowserWindow, ipcMain, globalShortcut, screen, clipboard, shell, Tray, Menu, crashReporter } = require("electron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");

const hasSingleInstanceLock=app.requestSingleInstanceLock();
if(!hasSingleInstanceLock)app.quit();

const diagnosticsDir=path.join(app.getPath("userData"),"diagnostics");
const crashDumpDir=path.join(diagnosticsDir,"dumps");
const sessionMarker=path.join(diagnosticsDir,"active-session.json");
const sessionId=`${new Date().toISOString().replace(/[:.]/g,"-")}-${process.pid}`;
if(hasSingleInstanceLock){fs.mkdirSync(crashDumpDir,{recursive:true});app.setPath("crashDumps",crashDumpDir);crashReporter.start({productName:"Fog Companion",uploadToServer:false,extra:{version:app.getVersion(),sessionId}})}

const diagnosticValue=value=>{
  if(value instanceof Error)return{name:value.name,message:value.message,stack:value.stack};
  if(value===undefined)return null;
  try{return JSON.parse(JSON.stringify(value))}catch{return String(value)}
};
function diagnosticStamp(){return new Date().toISOString()}
function logDiagnostic(level,event,details={}){
  try{fs.mkdirSync(diagnosticsDir,{recursive:true});fs.appendFileSync(path.join(diagnosticsDir,"fog-companion.log"),`${JSON.stringify({time:diagnosticStamp(),sessionId,pid:process.pid,level,event,details:diagnosticValue(details)})}\n`,"utf8")}catch{}
}
function writeCrashReport(kind,error,details={}){
  try{fs.mkdirSync(diagnosticsDir,{recursive:true});const file=path.join(diagnosticsDir,`crash-${new Date().toISOString().replace(/[:.]/g,"-")}-${kind}.json`);fs.writeFileSync(file,JSON.stringify({time:diagnosticStamp(),sessionId,pid:process.pid,version:app.getVersion(),kind,error:diagnosticValue(error),details:diagnosticValue(details)},null,2),"utf8");logDiagnostic("error",kind,{report:file,error:diagnosticValue(error),...details});return file}catch{return""}
}
function beginDiagnosticSession(){
  try{if(fs.existsSync(sessionMarker)){const previous=JSON.parse(fs.readFileSync(sessionMarker,"utf8"));writeCrashReport("unclean-shutdown",new Error("Предыдущая сессия завершилась без штатного выхода."),{previous})}fs.writeFileSync(sessionMarker,JSON.stringify({sessionId,pid:process.pid,startedAt:diagnosticStamp(),version:app.getVersion()},null,2),"utf8");logDiagnostic("info","app-start",{version:app.getVersion(),packaged:app.isPackaged})}catch(error){logDiagnostic("error","diagnostics-init-failed",error)}
}
function finishDiagnosticSession(reason){logDiagnostic("info","app-exit",{reason});try{if(fs.existsSync(sessionMarker))fs.unlinkSync(sessionMarker)}catch(error){logDiagnostic("error","session-marker-remove-failed",error)}}

if(hasSingleInstanceLock){process.on("uncaughtException",error=>{writeCrashReport("uncaught-exception",error);app.isQuitting=true;try{app.exit(1)}catch{process.exit(1)}});process.on("unhandledRejection",reason=>writeCrashReport("unhandled-rejection",reason));beginDiagnosticSession()}

let mainWindow;
let overlayWindow;
let statsWindow;
let tray;
let store;
let lastAutoSyncAttempt=0;
const perkDetailsCache=new Map();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const dataFile = () => path.join(app.getPath("userData"), "companion-data.json");
const statsOrigin = "https://stats.deadbydaylight.com";
const assetsOrigin = "https://assets.live.bhvraccount.com";
const githubRepository = "Jordandor/Fog-Companion";
const githubLatestReleaseApi = `https://api.github.com/repos/${githubRepository}/releases/latest`;
const appIcon = () => path.join(__dirname,"assets","fog-companion.ico");
let updateState={status:"idle",currentVersion:app.getVersion(),latestVersion:"",message:"Обновления еще не проверялись.",downloadUrl:"",checksumUrl:""};

const versionParts=value=>String(value||"").replace(/^v/i,"").split(/[.-]/).slice(0,3).map(part=>Number.parseInt(part,10)||0);
function isNewerVersion(candidate,current){const next=versionParts(candidate),installed=versionParts(current);for(let index=0;index<3;index++){if(next[index]!==installed[index])return next[index]>installed[index]}return false}
function publishUpdateState(next){updateState={...updateState,...next,currentVersion:app.getVersion()};send("update:status",updateState);return updateState}
async function githubResponse(url){
  const response=await fetch(url,{headers:{Accept:"application/vnd.github+json","User-Agent":`Fog-Companion/${app.getVersion()}`,"X-GitHub-Api-Version":"2022-11-28"},redirect:"follow",signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error(`GitHub ответил ${response.status}`);
  return response;
}
async function checkForUpdates(manual=false){
  publishUpdateState({status:"checking",message:"Проверяю GitHub Releases…"});
  try{
    const release=await (await githubResponse(githubLatestReleaseApi)).json(),latest=String(release?.tag_name||release?.name||"").replace(/^v/i,"");
    const assets=Array.isArray(release?.assets)?release.assets:[],executable=assets.find(asset=>asset?.name==="Fog Companion.exe"),checksum=assets.find(asset=>asset?.name==="Fog Companion.exe.sha256");
    if(!latest||!executable?.browser_download_url||!checksum?.browser_download_url)throw new Error("В последнем релизе отсутствуют EXE или SHA-256.");
    if(!isNewerVersion(latest,app.getVersion()))return publishUpdateState({status:"current",latestVersion:latest,message:`Установлена актуальная версия ${app.getVersion()}.`,downloadUrl:"",checksumUrl:""});
    const state=publishUpdateState({status:"available",latestVersion:latest,message:`Доступна версия ${latest}.`,downloadUrl:executable.browser_download_url,checksumUrl:checksum.browser_download_url});
    if(!manual)send("update:status",{...state,notify:true});
    return state;
  }catch(error){logDiagnostic("warn","update-check-failed",{error:diagnosticValue(error)});return publishUpdateState({status:"error",message:`Не удалось проверить обновления: ${error.message}`,downloadUrl:"",checksumUrl:""})}
}
async function installAvailableUpdate(){
  if(updateState.status!=="available"||!updateState.downloadUrl||!updateState.checksumUrl)throw new Error("Сначала проверьте наличие обновлений.");
  const portableExecutable=process.env.PORTABLE_EXECUTABLE_FILE;
  if(!app.isPackaged||!portableExecutable)throw new Error("Автоустановка доступна только в portable-версии Fog Companion.");
  publishUpdateState({status:"downloading",message:`Скачиваю версию ${updateState.latestVersion}…`});
  const stagingDir=path.join(app.getPath("temp"),"fog-companion-update");fs.mkdirSync(stagingDir,{recursive:true});
  const stagedExecutable=path.join(stagingDir,`Fog-Companion-${updateState.latestVersion}.exe`),scriptPath=path.join(stagingDir,"install-update.ps1");
  try{
    const [binaryResponse,checksumResponse]=await Promise.all([githubResponse(updateState.downloadUrl),githubResponse(updateState.checksumUrl)]),binary=Buffer.from(await binaryResponse.arrayBuffer()),checksumText=await checksumResponse.text(),expected=(checksumText.match(/\b[a-f0-9]{64}\b/i)||[])[0]?.toUpperCase();
    if(!expected)throw new Error("Релиз не содержит корректную контрольную сумму.");
    const actual=crypto.createHash("sha256").update(binary).digest("hex").toUpperCase();
    if(actual!==expected)throw new Error("Контрольная сумма обновления не совпала. Установка отменена.");
    fs.writeFileSync(stagedExecutable,binary);
    const script=`param([int]$TargetPid,[string]$Source,[string]$Destination)\n$limit=(Get-Date).AddSeconds(45)\nwhile((Get-Process -Id $TargetPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $limit){Start-Sleep -Milliseconds 250}\nfor($attempt=0;$attempt -lt 20;$attempt++){try{Copy-Item -LiteralPath $Source -Destination $Destination -Force;Start-Process -FilePath $Destination;Remove-Item -LiteralPath $Source -Force -ErrorAction SilentlyContinue;exit 0}catch{Start-Sleep -Milliseconds 500}}\nexit 1\n`;
    fs.writeFileSync(scriptPath,script,"utf8");publishUpdateState({status:"installing",message:"Обновление проверено. Перезапускаю Companion…"});
    const child=spawn("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",scriptPath,"-TargetPid",String(process.pid),"-Source",stagedExecutable,"-Destination",portableExecutable],{detached:true,stdio:"ignore",windowsHide:true});child.unref();app.isQuitting=true;setTimeout(()=>app.quit(),250);return true;
  }catch(error){logDiagnostic("error","update-install-failed",{error:diagnosticValue(error)});publishUpdateState({status:"available",message:`Не удалось установить обновление: ${error.message}`});throw error}
}

function demoParticipant(role, character, result, score, perks, number) {
  return { role, character:{ name:character, image:"" }, nickname: role === "killer" ? "Игрок" : `Выживший ${number}`,
    result, score, perks:perks.map(name => ({name,image:""})), addOns:[], offering:null, power:null, emblems:[] };
}

function defaultData() {
  const now = Math.floor(Date.now()/1000);
  return {
    version:1,
    profile:{ name:"Игрок", platform:"Steam" },
    meta:{ demo:true, lastSync:null, source:"demo" },
    settings:{ automationEnabled:false, openPoint:null, searchPoint:null, resultPoint:null, wheelCooldown:3, wheelCooldowns:{}, enabledKillerIds:[] },
    matches:[
      { id:"demo-1", startTime:now-3600, duration:812, map:"Поместье Макмиллан", gameType:"1v4", kills:4,
        player:demoParticipant("killer","Кошмар","Безжалостный убийца",32210,["Барбекю и чили","Нокаут","Выхода нет","Секущий крюк"],0),
        participants:[
          demoParticipant("survivor","Мэг Томас","Принесена в жертву",18420,["Спринтер","Адреналин","Гибкость","Окна возможностей"],1),
          demoParticipant("survivor","Клодетт Морель","Принесена в жертву",16280,["Сам себе доктор","Ботаника","Мы справимся","Круг исцеления"],2),
          demoParticipant("survivor","Дуайт Фэйрфилд","Убит",14990,["Связь","Докажи, что ты достоин","Лидер","Дежавю"],3),
          demoParticipant("survivor","Ниа Карлссон","Принесена в жертву",20140,["Крепкий орешек","Решающий удар","Самообладание","Искажение"],4)
        ] },
      { id:"demo-2", startTime:now-86400, duration:1038, map:"Автохевен", gameType:"1v4", kills:2,
        player:demoParticipant("killer","Охотница","Жестокий убийца",27650,["Смертельный преследователь","Тьма раскрывается","Железная дева","Нетерпимость"],0),
        participants:[
          demoParticipant("survivor","Сейбл Уорд","Сбежала",24500,["Сила во мраке","Плетение пауков","Ловкость","Окна возможностей"],1),
          demoParticipant("survivor","Леон Кеннеди","Принесен в жертву",17010,["Световая граната","Укус дракона","Адреналин","Мы будем жить вечно"],2),
          demoParticipant("survivor","Эйс Висконти","Сбежал",25980,["Повысить ставки","Туз в рукаве","Гибкость","Искажение"],3),
          demoParticipant("survivor","Фэн Мин","Убита",19800,["Техник","Гибкость","Спринтер","Дежавю"],4)
        ] },
      { id:"demo-3", startTime:now-172800, duration:684, map:"Мидвичская школа", gameType:"1v4", kills:3,
        player:demoParticipant("killer","Немезис","Безжалостный убийца",29840,["Преследователь-убийца","Эрупция","Вызов медсестры","Выхода нет"],0),
        participants:[
          demoParticipant("survivor","Джилл Валентайн","Принесена в жертву",17100,["Противодействие","Фугасная мина","Адреналин","Железная воля"],1),
          demoParticipant("survivor","Ребекка Чемберс","Сбежала",23110,["Уверенность","Лучше, чем вчера","Связь","Дежавю"],2),
          demoParticipant("survivor","Дуайт Фэйрфилд","Убит",15440,["Лидер","Связь","Докажи, что ты достоин","Окна возможностей"],3),
          demoParticipant("survivor","Кейт Денсон","Принесена в жертву",18300,["Танец со мной","Гибкость","Самообладание","Спринтер"],4)
        ] },
      { id:"demo-4", startTime:now-248400, duration:925, map:"Холодильник Гидеон", gameType:"1v4", kills:null,
        player:demoParticipant("survivor","Сейбл Уорд","Сбежала",24780,["Сила во мраке","Окна возможностей","Гибкость","Дежавю"],0),
        participants:[
          demoParticipant("killer","Дух","Жестокий убийца",28100,["Порча: погибель","Наблюдение","Выхода нет","Зов моря"],1),
          demoParticipant("survivor","Мэг Томас","Принесена в жертву",16840,["Спринтер","Адреналин","Самообладание","Связь"],2),
          demoParticipant("survivor","Дуайт Фэйрфилд","Сбежал",23950,["Лидер","Докажи, что ты достоин","Связь","Дежавю"],3),
          demoParticipant("survivor","Ниа Карлссон","Убита",15120,["Гибкость","Крепкий орешек","Решающий удар","Окна возможностей"],4)
        ] }
    ]
  };
}

function loadStore() {
  try { return refreshMatchKillCounts(JSON.parse(fs.readFileSync(dataFile(), "utf8"))); }
  catch { const value=defaultData(); writeStore(value); return value; }
}

function resultText(value){
  const text=String(value||"");
  if(/^(?:VE_)?SurrenderLoss$/i.test(text))return "СДАЛСЯ (ПОРАЖЕНИЕ)";
  if(/^(?:VE_)?Disconnected$/i.test(text))return "ПОТЕРЯ СОЕДИНЕНИЯ";
  if(/^(?:VE_)?ManuallyLeftMatch$/i.test(text))return "ВЫШЕЛ ИЗ МАТЧА";
  return text;
}

function refreshMatchKillCounts(value){
  for(const match of value.matches||[]){
    if(match.player?.role!=="killer")continue;
    const survivors=[match.player,...(match.participants||[])].filter(person=>person?.role==="survivor");
    match.kills=survivors.filter(person=>person.result&&!escaped(person)&&!leftTrial(person)).length;
  }
  return value;
}

function writeStore(value) {
  const target=dataFile(); fs.mkdirSync(path.dirname(target),{recursive:true});
  const temporary=`${target}.tmp`; fs.writeFileSync(temporary,JSON.stringify(value,null,2),"utf8");
  try { fs.renameSync(temporary,target); }
  catch { fs.copyFileSync(temporary,target); fs.unlinkSync(temporary); }
}

function send(channel,value) { if(mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel,value); }

async function responseBodyWithRetry(webContents,requestId) {
  let lastError;
  for(const delay of [0,120,350,700]){
    if(delay)await sleep(delay);
    try{return await webContents.debugger.sendCommand("Network.getResponseBody",{requestId});}
    catch(error){lastError=error;}
  }
  throw lastError||new Error("Ответ официального трекера недоступен");
}

async function historyPayloadFromPage(webContents) {
  return webContents.executeJavaScript(`(async()=>{
    try{
      const urls=performance.getEntriesByType("resource").map(entry=>entry.name).filter(url=>url.includes("/player-stats/match-history/games/dbd/providers/")&&/[?&]lang=ru(?:&|$)/.test(url));
      const target=urls.at(-1);
      if(!target)return{ok:false,reason:"history-url-not-ready"};
      let token="";
      try{token=JSON.parse(localStorage.getItem("auth-store")||"{}")?.state?.authToken?.token||""}catch{}
      const headers={Accept:"application/json"};
      if(token)headers.Authorization=/^Bearer /i.test(token)?token:"Bearer "+token;
      const response=await fetch(target,{method:"GET",headers,credentials:"include",cache:"no-store"});
      if(!response.ok)return{ok:false,status:response.status,reason:"history-request-failed"};
      return{ok:true,payload:await response.json()};
    }catch(error){return{ok:false,reason:error?.message||"history-request-error"}}
  })()`,true);
}

async function aggregatePayloadFromPage(webContents) {
  return webContents.executeJavaScript(`(async()=>{
    try{
      const resourceUrls=performance.getEntriesByType("resource").map(entry=>entry.name);
      const directStatsUrl=resourceUrls.find(url=>url.includes("/player-stats/games/dbd/providers/")&&/[?&]lang=ru(?:&|$)/.test(url));
      const historyUrl=resourceUrls.find(url=>url.includes("/player-stats/match-history/games/dbd/providers/"));
      const source=new URL(historyUrl||location.origin);
      const match=historyUrl?source.pathname.match(/\/providers\/([^/]+)/):null;
      let provider=match?decodeURIComponent(match[1]):"";
      if(!provider){try{const value=JSON.parse(localStorage.getItem("providers-store")||"{}");const state=value?.state||value;provider=state?.selectedProvider||state?.defaultProvider||state?.provider||""}catch{}}
      if(provider&&typeof provider==="object")provider=provider.id||provider.providerId||provider.value||"";
      if(!provider&&!directStatsUrl)return{ok:false,reason:"provider-not-ready",localStorageKeys:Object.keys(localStorage)};
      let token="";
      try{token=JSON.parse(localStorage.getItem("auth-store")||"{}")?.state?.authToken?.token||""}catch{}
      const headers={Accept:"application/json"};
      if(token)headers.Authorization=/^Bearer /i.test(token)?token:"Bearer "+token;
      const apiOrigin=historyUrl?source.origin:"https://account-backend.bhvr.com";
      const target=directStatsUrl?new URL(directStatsUrl):new URL("/player-stats/games/dbd/providers/"+encodeURIComponent(provider),apiOrigin);
      if(!target.searchParams.has("lang"))target.searchParams.set("lang","ru");
      const response=await fetch(target,{method:"GET",headers,credentials:"include",cache:"no-store"});
      if(!response.ok)return{ok:false,status:response.status,reason:"stats-request-failed",target:target.href,hasToken:Boolean(token),responseText:(await response.text()).slice(0,500)};
      return{ok:true,payload:await response.json(),target:target.href};
    }catch(error){return{ok:false,reason:error?.message||"stats-request-error"}}
  })()`,true);
}

async function aggregateCategoryPayloadFromPage(webContents,matchCategory="Regular") {
  return webContents.executeJavaScript(`(async()=>{
    try{
      const resourceUrls=performance.getEntriesByType("resource").map(entry=>entry.name);
      const statsUrl=resourceUrls.find(url=>url.includes("/player-stats/games/dbd/providers/")&&/[?&]lang=ru(?:&|$)/.test(url));
      if(!statsUrl)return{ok:false,reason:"stats-url-not-ready"};
      let token="";
      try{token=JSON.parse(localStorage.getItem("auth-store")||"{}")?.state?.authToken?.token||""}catch{}
      const headers={Accept:"application/json"};
      if(token)headers.Authorization=/^Bearer /i.test(token)?token:"Bearer "+token;
      const target=new URL(statsUrl);
      target.searchParams.set("matchCategory",${JSON.stringify(matchCategory)});
      const response=await fetch(target,{method:"GET",headers,credentials:"include",cache:"no-store"});
      if(!response.ok)return{ok:false,status:response.status,reason:"stats-category-request-failed",target:target.href,hasToken:Boolean(token),responseText:(await response.text()).slice(0,500)};
      return{ok:true,payload:await response.json(),target:target.href};
    }catch(error){return{ok:false,reason:error?.message||"stats-category-request-error"}}
  })()`,true);
}

function decodeHtml(value){return String(value||"").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'");}
async function currentSteamAvatar(account) {
  const fallback=normalizeImage(account?.avatarUrl||"");
  const profileUrl=account?.profileUrl||"";
  if(account?.type!=="steam"||!/^https:\/\/steamcommunity\.com\//i.test(profileUrl))return fallback;
  try{
    const response=await fetch(profileUrl,{headers:{"User-Agent":"Mozilla/5.0 FogCompanion/0.1.14"},signal:AbortSignal.timeout(8000)});
    if(!response.ok)return fallback;
    const html=await response.text();
    const match=html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)||html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    return match?.[1]?decodeHtml(match[1]):fallback;
  }catch{return fallback;}
}

async function refreshStoredProfileAvatar() {
  const profile=store.profile||{};
  if(profile.platform!=="STEAM"||!profile.profileUrl)return false;
  const avatar=await currentSteamAvatar({type:"steam",profileUrl:profile.profileUrl,avatarUrl:profile.avatar});
  if(!avatar||avatar===profile.avatar)return false;
  store.profile={...profile,avatar};writeStore(store);send("sync:status",{type:"silent",message:"",data:store});return true;
}

const addonIndexPages=["Фонарик (улучшения)","Аптечка (улучшения)","Ящик с инструментами (улучшения)","Карта (улучшения)","Ключ (улучшения)"];
const wikiOrigin="https://dead-by-daylight.fandom.com";
async function getPerkDetails(perk,kind="Навык") {
  const name=String(perk?.name||"").trim();
  if(!name)throw new Error("Название элемента не найдено");
  const key=`${String(kind).toLocaleLowerCase("ru-RU")}:${name.toLocaleLowerCase("ru-RU")}`;
  if(perkDetailsCache.has(key))return perkDetailsCache.get(key);
  const requestJson=async url=>{
    let lastError;
    for(let attempt=1;attempt<=3;attempt++){
      try{
        const response=await fetch(url,{headers:{"User-Agent":`FogCompanion/${app.getVersion()}`},redirect:"follow",signal:AbortSignal.timeout(9000)});
        if(!response.ok)throw new Error(`Источник описаний ответил ${response.status}`);
        return await response.json();
      }catch(error){
        lastError=error;
        logDiagnostic("warn","item-details-request-retry",{attempt,url,error:diagnosticValue(error)});
        if(attempt<3)await sleep(attempt*350);
      }
    }
    throw new Error(`Источник описаний временно недоступен${lastError?.message?`: ${lastError.message}`:""}`);
  };
  const preferred=String(perk?.id||"").trim(),isAddon=/^аддон/i.test(String(kind)),addonOwner=String(perk?.owner||"").trim();
  const normalizedWikiName=name.replace(/[«»]/g,'"').replace(/[‘’]/g,"'");
  let page="",payload=null;
  for(const candidate of [...new Set((isAddon?[]:[name,normalizedWikiName,preferred]).filter(Boolean))]){
    const candidatePage=candidate.replace(/\s+/g,"_");
    const candidatePayload=await requestJson(`${wikiOrigin}/ru/api.php?action=parse&page=${encodeURIComponent(candidatePage)}&prop=text|displaytitle&format=json&formatversion=2&origin=*`);
    if(!candidatePayload?.error&&candidatePayload?.parse?.text){page=candidatePage;payload=candidatePayload;break;}
  }
  if(!payload?.parse?.text&&isAddon){
    for(const candidate of [...new Set([addonOwner?`${addonOwner} (улучшения)`:"",...addonIndexPages].filter(Boolean))]){
      const candidatePage=candidate.replace(/\s+/g,"_");
      const candidatePayload=await requestJson(`${wikiOrigin}/ru/api.php?action=parse&page=${encodeURIComponent(candidatePage)}&prop=text|displaytitle&format=json&formatversion=2&origin=*`);
      if(!candidatePayload?.error&&candidatePayload?.parse?.text&&candidatePayload.parse.text.toLocaleLowerCase("ru-RU").includes(name.toLocaleLowerCase("ru-RU"))){page=candidatePage;payload=candidatePayload;break;}
    }
  }
  if(!payload?.parse?.text){
    const search=await requestJson(`${wikiOrigin}/ru/api.php?action=opensearch&search=${encodeURIComponent(name)}&limit=5&namespace=0&format=json&origin=*`);
    const found=Array.isArray(search?.[1])?search[1][0]:"";
    if(!found)throw new Error("Описание этого элемента пока не найдено");
    page=found.replace(/\s+/g,"_");
    payload=await requestJson(`${wikiOrigin}/ru/api.php?action=parse&page=${encodeURIComponent(page)}&prop=text|displaytitle&format=json&formatversion=2&origin=*`);
  }
  if(payload?.error||!payload?.parse?.text)throw new Error("Описание этого элемента пока не найдено");
  const result={html:payload.parse.text,title:payload.parse.title||name,sourceUrl:`${wikiOrigin}/ru/wiki/${encodeURIComponent(page)}`};
  perkDetailsCache.set(key,result);
  return result;
}

function normalizeImage(value) {
  if(!value) return "";
  if(/^https?:\/\//i.test(value)) return value;
  if(value.startsWith("//")) return `https:${value}`;
  if(value.startsWith("/_next/")||value.startsWith("/static/")||value.startsWith("/assets/")||value.startsWith("/src/assets/")) return `${statsOrigin}${value}`;
  return `${assetsOrigin}/${value.replace(/^\/+/,"")}`;
}

function normalizeItem(item) {
  if(!item) return null;
  return { id:item.id||"", name:item.name||item.id||"Неизвестно", image:normalizeImage(item.image?.path||item.image||"") };
}

function roleOf(value) { return value === "VE_Camper" || /survivor/i.test(value||"") ? "survivor" : "killer"; }
function participantFromRaw(raw,index) {
  const role=roleOf(raw.playerRole);
  const resultRaw=role === "survivor" ? raw.playerStatus : raw.killerMatchStatus;
  const result=resultText(typeof resultRaw === "string" ? resultRaw : resultRaw?.name||resultRaw?.id||"");
  const character=raw.characterName||raw.character||{};
  const loadout=raw.characterLoadout||raw.loadout||{};
  return {
    role,
    nickname:raw.nickname||raw.playerName||raw.displayName||(role === "killer" ? "Убийца" : `Выживший ${index+1}`),
    profileUrl:raw.profileUrl||raw.steamProfileUrl||"",
    character:{ id:character.id||"", name:character.name||character.id||"Неизвестно", image:normalizeImage(character.image?.path||character.image||"") },
    result,
    score:Number(raw.leaderboardScore||raw.score||0),
    perks:(loadout.perks||[]).map(normalizeItem).filter(Boolean),
    addOns:(loadout.addOns||loadout.addons||[]).map(normalizeItem).filter(Boolean),
    offering:normalizeItem(loadout.offering), power:normalizeItem(loadout.power||loadout.item||loadout.inventoryItem),
    emblems:(raw.emblems||[]).map(e=>({id:e.emblem_id||e.id||"",name:e.emblem_name||e.name||"",quality:e.emblem_quality||e.quality||""}))
  };
}

function escaped(participant) { return /escape|escaped|hatch|gate|сбеж|выжил/i.test(participant.result||""); }
function leftTrial(participant) { return /surrender|disconnect|manuallyleft|сдался|покинул матч|потеря соединения|вышел из матча/i.test(participant.result||""); }
function normalizeMatches(payload) {
  const rows=Array.isArray(payload)?payload:(payload?.data||payload?.items||payload?.results||[]);
  if(!Array.isArray(rows)) return [];
  return rows.map((entry,rowIndex)=>{
    const match=entry.matchStat||entry.match||{};
    const player=participantFromRaw(entry.playerStat||entry.player||{},0);
    const others=(entry.opponentStat||entry.opponents||[]).map((p,i)=>participantFromRaw(p,i));
    const survivors=[player,...others].filter(p=>p.role==="survivor");
    const duration=Number(match.matchDuration||(entry.playerStat||{}).playerTimeInMatch||0);
    const seed=`${match.matchStartTime||Date.now()}-${duration}-${match.map?.id||match.map?.name||"map"}-${player.role}`;
    return {
      id:match.id||crypto.createHash("sha1").update(seed).digest("hex").slice(0,16),
      startTime:Number(match.matchStartTime||Math.floor(Date.now()/1000)), duration,
      map:match.map?.name||"Неизвестная карта", mapImage:normalizeImage(match.map?.image?.path||""),
      gameType:/^online$/i.test(match.gameType?.name||match.gameType?.id||"")?"Обычный матч":match.gameType?.name||match.gameType?.id||"Обычный матч", player, participants:others,
      // Surrender/disconnect are distinct outcomes, not explicit kill statuses.
      kills:player.role==="killer" ? survivors.filter(p=>p.result && !escaped(p)&&!leftTrial(p)).length : null
    };
  });
}

function aggregateNumber(value) {
  if(typeof value==="number"&&Number.isFinite(value))return value;
  if(value&&typeof value==="object"&&typeof value.All==="number")return value.All;
  return 0;
}

function normalizeAggregateCharacter(raw,role) {
  const metrics={};
  Object.entries(raw||{}).forEach(([key,value])=>{
    if(typeof value==="number"&&Number.isFinite(value))metrics[key]=value;
    else if(value&&typeof value==="object"&&typeof value.All==="number")metrics[key]=value.All;
  });
  return {
    id:raw.character_id||raw.id||"",
    name:raw.character_name||raw.name||"Неизвестно",
    image:normalizeImage(raw.image?.path||raw.image||""),
    role,
    hoursPlayed:aggregateNumber(raw.hours_played_in_match),
    pickRate:aggregateNumber(raw.pick_rate),
    performanceRate:aggregateNumber(role==="killer"?raw.kill_rate:raw.escape_rate),
    metrics
  };
}

function normalizeAggregateStats(payload) {
  const data=payload?.data||payload||{},timeframes={};
  for(const timeframe of ["30-days","all-time"]){
    const frame=data[timeframe]||{},characters=frame.characters||{};
    const killerRows=frame.killers?.characters||characters.killers||frame.killers||[];
    const survivorRows=frame.survivors?.characters||characters.survivors||frame.survivors||[];
    timeframes[timeframe]={
      killers:(Array.isArray(killerRows)?killerRows:[]).map(raw=>normalizeAggregateCharacter(raw,"killer")).sort((a,b)=>b.hoursPlayed-a.hoursPlayed),
      survivors:(Array.isArray(survivorRows)?survivorRows:[]).map(raw=>normalizeAggregateCharacter(raw,"survivor")).sort((a,b)=>b.hoursPlayed-a.hoursPlayed)
    };
  }
  if(!timeframes["30-days"].killers.length&&!timeframes["30-days"].survivors.length&&!timeframes["all-time"].killers.length&&!timeframes["all-time"].survivors.length)return null;
  return {updatedAt:payload?.updatedAt||null,ingestedAt:payload?.ingestedAt||null,syncedAt:Date.now(),timeframes};
}

function importAggregateStats(payload,{silent=false}={}) {
  const normalized=normalizeAggregateStats(payload);
  if(!normalized)return false;
  store.officialStats=normalized;
  writeStore(store);
  send("sync:status",{type:silent?"silent":"success",message:silent?"":"Статистика персонажей обновлена",data:store});
  return true;
}

function importOfficial(payload,{silent=false}={}) {
  const imported=normalizeMatches(payload);
  if(!imported.length) return 0;
  const existing=store.meta?.demo?[]:store.matches||[];
  const map=new Map(existing.map(m=>[m.id,m])); imported.forEach(m=>map.set(m.id,m));
  store.matches=[...map.values()].sort((a,b)=>b.startTime-a.startTime).slice(0,500);
  store.meta={demo:false,lastSync:Date.now(),source:"official-stats"}; writeStore(store);
  send("sync:status",{type:silent?"silent":"success",message:silent?"":`Импортировано матчей: ${imported.length}`,data:store});
  return imported.length;
}

async function importProfile(payload,{silent=false}={}) {
  if(!payload||typeof payload!=="object")return false;
  const accounts=Array.isArray(payload.accounts)?payload.accounts:[];
  const account=accounts.find(item=>item.type==="steam"&&item.avatarUrl)||accounts.find(item=>item.avatarUrl)||accounts[0]||{};
  const next={
    name:payload.nickName||account.userName||store.profile?.name||"Игрок DBD",
    platform:String(account.type||store.profile?.platform||"Behaviour").toUpperCase(),
    avatar:await currentSteamAvatar(account),
    profileUrl:account.profileUrl||""
  };
  if(JSON.stringify(store.profile||{})===JSON.stringify(next))return false;
  store.profile=next;writeStore(store);
  send("sync:status",{type:silent?"silent":"info",message:silent?"":"Профиль найден. Загружаю историю матчей…",data:store});
  return true;
}

function createMainWindow() {
  mainWindow=new BrowserWindow({
    minWidth:1120,minHeight:720,width:1540,height:940,show:false,frame:false,backgroundColor:"#0b0c10",icon:appIcon(),
    webPreferences:{preload:path.join(__dirname,"preload.js"),contextIsolation:true,nodeIntegration:false}
  });
  mainWindow.loadFile("index.html");
  mainWindow.once("ready-to-show",()=>{if(process.argv.includes("--sync-once"))return;mainWindow.maximize();mainWindow.show();});
  mainWindow.on("close",event=>{if(!app.isQuitting){event.preventDefault();mainWindow.hide();logDiagnostic("info","main-window-hidden",{source:"close-button"})}});
  mainWindow.on("closed",()=>{logDiagnostic("info","main-window-destroyed");mainWindow=null;});
  mainWindow.on("unresponsive",()=>writeCrashReport("main-window-unresponsive",new Error("Главное окно перестало отвечать.")));
  mainWindow.webContents.on("render-process-gone",(_event,details)=>{if(!app.isQuitting&&details.reason!=="clean-exit")writeCrashReport("main-render-process-gone",new Error(`Renderer: ${details.reason}`),details)});
}

function showMainWindow(){
  if(!mainWindow||mainWindow.isDestroyed()){createMainWindow();return;}
  if(mainWindow.isMinimized())mainWindow.restore();
  mainWindow.show();mainWindow.focus();
}

function createTray(){
  if(tray)return;
  tray=new Tray(appIcon());
  tray.setToolTip("Fog Companion");
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:"Открыть Fog Companion",click:showMainWindow},
    {label:"Показать или скрыть оверлей",accelerator:"Shift+F2",click:()=>toggleOverlay()},
    {label:"Открыть папку с логами",click:async()=>{fs.mkdirSync(diagnosticsDir,{recursive:true});const error=await shell.openPath(diagnosticsDir);if(error)logDiagnostic("error","open-diagnostics-failed",{error})}},
    {type:"separator"},
    {label:"Выйти полностью",click:()=>{logDiagnostic("info","tray-exit-requested");app.isQuitting=true;app.quit();}}
  ]));
  tray.on("click",showMainWindow);
}

app.on("second-instance",showMainWindow);

function positionOverlay() {
  if(!overlayWindow||overlayWindow.isDestroyed())return;
  const display=screen.getDisplayNearestPoint(screen.getCursorScreenPoint()),area=display.workArea;
  const [width,height]=overlayWindow.getSize();
  overlayWindow.setPosition(area.x+area.width-width-22,area.y+Math.max(22,Math.round((area.height-height)/2)),false);
}

function createOverlayWindow() {
  overlayWindow=new BrowserWindow({
    width:452,height:806,show:false,frame:false,resizable:false,maximizable:false,minimizable:false,skipTaskbar:true,
    transparent:false,backgroundColor:"#090a0d",alwaysOnTop:true,fullscreenable:false,icon:appIcon(),
    webPreferences:{preload:path.join(__dirname,"preload.js"),contextIsolation:true,nodeIntegration:false}
  });
  overlayWindow.setAlwaysOnTop(true,"screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
  overlayWindow.loadFile("overlay.html");
  overlayWindow.on("close",event=>{if(!app.isQuitting){event.preventDefault();overlayWindow.hide();}});
  overlayWindow.webContents.on("render-process-gone",(_event,details)=>{if(!app.isQuitting&&details.reason!=="clean-exit")writeCrashReport("overlay-render-process-gone",new Error(`Overlay renderer: ${details.reason}`),details)});
}

async function toggleOverlay() {
  if(!overlayWindow||overlayWindow.isDestroyed())createOverlayWindow();
  if(overlayWindow.isVisible()){overlayWindow.hide();return;}
  if(!await gameRunning()){
    send("game:selection-status",{type:"error",message:"Оверлей Shift+F2 доступен только при запущенном Dead by Daylight."});
    return;
  }
  positionOverlay();
  overlayWindow.show();
  overlayWindow.focus();
  overlayWindow.webContents.send("overlay:shown",store);
}

function openStatsSync(silent=false) {
  if(statsWindow&&!statsWindow.isDestroyed()){if(!silent){statsWindow.show();statsWindow.focus();}return;}
  const syncWindow=new BrowserWindow({
    width:1240,height:860,show:!silent,title:"Вход в официальный DBD Stats Tracker",backgroundColor:"#111216",icon:appIcon(),
    webPreferences:{partition:"persist:bhvr-stats",contextIsolation:true,nodeIntegration:false,sandbox:true}
  });
  statsWindow=syncWindow;
  syncWindow.webContents.setWindowOpenHandler(()=>({action:"allow",overrideBrowserWindowOptions:{parent:syncWindow,webPreferences:{partition:"persist:bhvr-stats",contextIsolation:true,nodeIntegration:false,sandbox:true}}}));
  const historyUrl=`${statsOrigin}/ru/match-history/`;
  const statisticsUrl=`${statsOrigin}/ru/statistics/`;
  const pendingResponses=new Map();
  let redirectAttempts=0;
  let importedHistory=false;
  let aggregateFinished=false;
  let aggregateImported=false;
  let pageFallbackStarted=false;
  let aggregateImportStarted=false;
  let categoryImportStarted=false;
  let statisticsNavigationStarted=false;
  let historyReadError="";
  const finishIfReady=()=>{
    if(importedHistory&&aggregateFinished)setTimeout(()=>{if(!syncWindow.isDestroyed())syncWindow.close();},800);
  };
  const openStatisticsPage=()=>{
    if(statisticsNavigationStarted||syncWindow.isDestroyed())return;
    statisticsNavigationStarted=true;
    setTimeout(()=>{if(!syncWindow.isDestroyed())syncWindow.loadURL(statisticsUrl);},350);
  };
  const acceptHistory=payload=>{
    const count=importOfficial(payload,{silent});
    if(count){importedHistory=true;openStatisticsPage();finishIfReady();}
    else if(!silent)send("sync:status",{type:"info",message:"Официальный трекер пока не вернул недавние матчи."});
    return count;
  };
  const acceptAggregate=payload=>{
    if(aggregateImported)return true;
    const imported=importAggregateStats(payload,{silent});
    if(imported){aggregateImported=true;aggregateFinished=true;finishIfReady();}
    return imported;
  };
  const runRegularCategoryImport=async()=>{
    if(categoryImportStarted||aggregateImported)return;
    categoryImportStarted=true;
    for(const delay of [250,1200,2600]){
      await sleep(delay);
      if(syncWindow.isDestroyed()||aggregateImported)return;
      try{
        const result=await aggregateCategoryPayloadFromPage(syncWindow.webContents,"Regular");
        if(result?.ok&&acceptAggregate(result.payload))return;
      }catch{}
    }
  };
  const runAggregateImport=async()=>{
    if(aggregateImportStarted)return;
    aggregateImportStarted=true;
    for(const delay of [2200,2800,4000]){
      await sleep(delay);
      if(syncWindow.isDestroyed()||aggregateImported)return;
      try{
        const result=await aggregatePayloadFromPage(syncWindow.webContents);
        if(result?.ok&&acceptAggregate(result.payload))return;
        if(result?.status===403||result?.status===404)break;
      }catch{}
    }
    aggregateFinished=true;
    if(!silent)send("sync:status",{type:"error",message:"Матчи обновлены, но статистику персонажей официальный трекер не вернул."});
    finishIfReady();
  };
  const runPageFallback=async()=>{
    if(pageFallbackStarted)return;
    pageFallbackStarted=true;
    for(const delay of [2500,3000,4500]){
      await sleep(delay);
      if(importedHistory||syncWindow.isDestroyed())return;
      try{
        const result=await historyPayloadFromPage(syncWindow.webContents);
        if(result?.ok&&acceptHistory(result.payload))return;
        if(result?.reason&&result.reason!=="history-url-not-ready")historyReadError=result.status?`источник ответил ${result.status}`:result.reason;
      }catch(error){historyReadError=error.message;}
    }
    if(importedHistory||syncWindow.isDestroyed())return;
    const message=historyReadError||"официальный трекер не вернул историю матчей";
    if(process.argv.includes("--sync-once"))console.error(`Sync history error: ${message}`);
    if(!silent)send("sync:status",{type:"error",message:`Не удалось обновить историю: ${message}`});
  };
  const onDebuggerMessage=async(_event,method,params)=>{
    if(method==="Network.requestWillBeSent"){
      const url=params.request?.url||"";
      const aggregate=url.includes("/player-stats/games/dbd/providers/")&&/[?&]lang=ru(?:&|$)/.test(url);
      if(aggregate)pendingResponses.set(params.requestId,{type:"aggregate",url});
      return;
    }
    if(method==="Network.responseReceived"){
      const url=params.response?.url||"";
      let pathname="";try{pathname=new URL(url).pathname}catch{}
      const history=url.includes("/player-stats/match-history/games/dbd/providers/")&&/[?&]lang=ru(?:&|$)/.test(url);
      const aggregate=url.includes("/player-stats/games/dbd/providers/")&&/[?&]lang=ru(?:&|$)/.test(url);
      const profile=pathname==="/players/me";
      if(history||aggregate||profile){
        const previous=pendingResponses.get(params.requestId)||{};
        pendingResponses.set(params.requestId,{...previous,type:history?"history":aggregate?"aggregate":"profile",url});
      }
      return;
    }
    if(method==="Network.loadingFailed"){pendingResponses.delete(params.requestId);return;}
    if(method!=="Network.loadingFinished"||!pendingResponses.has(params.requestId))return;
    const pending=pendingResponses.get(params.requestId);pendingResponses.delete(params.requestId);
    try {
      const body=await responseBodyWithRetry(syncWindow.webContents,params.requestId);
      const text=body.base64Encoded?Buffer.from(body.body,"base64").toString("utf8"):body.body;
      const payload=JSON.parse(text);
      if(pending.type==="profile"){await importProfile(payload,{silent});return;}
      if(pending.type==="aggregate"){
        if(acceptAggregate(payload))return;
        const categories=payload?.data?.["match-categories"]||[];
        const regular=categories.find(item=>item?.name==="Regular"&&item?.stats);
        if(regular)runRegularCategoryImport();
        return;
      }
      acceptHistory(payload);
    } catch(error) {
      if(pending.type==="history")historyReadError=error.message;
    }
  };
  syncWindow.webContents.on("did-finish-load",async()=>{
    if(syncWindow.isDestroyed())return;
    const current=syncWindow.webContents.getURL();
    if(!current.startsWith(statsOrigin))return;
    if(current.includes("/match-history")){
      if(!silent)send("sync:status",{type:"info",message:"Загружаю матчи, изображения и статистику персонажей…"});
      runPageFallback();
      return;
    }
    if(current.includes("/statistics")){
      runAggregateImport();
      return;
    }
    let authenticated=false;
    try{authenticated=await syncWindow.webContents.executeJavaScript("(()=>{try{return Boolean(JSON.parse(localStorage.getItem('auth-store')||'{}')?.state?.authToken?.token)}catch{return false}})()") }catch{}
    if(authenticated&&redirectAttempts<3){redirectAttempts++;if(!silent)send("sync:status",{type:"info",message:"Вход выполнен. Перехожу в историю недавних матчей…"});setTimeout(()=>{if(!syncWindow.isDestroyed())syncWindow.loadURL(historyUrl);},400);}
  });
  syncWindow.on("closed",()=>{if(statsWindow===syncWindow)statsWindow=null;if(process.argv.includes("--sync-once"))setTimeout(()=>app.quit(),300);});
  (async()=>{
    try{
      await syncWindow.loadURL("about:blank");
      if(syncWindow.isDestroyed())return;
      syncWindow.webContents.debugger.attach("1.3");
      syncWindow.webContents.debugger.on("message",onDebuggerMessage);
      await syncWindow.webContents.debugger.sendCommand("Network.enable");
      await syncWindow.webContents.debugger.sendCommand("Network.setCacheDisabled",{cacheDisabled:true});
      if(!syncWindow.isDestroyed())await syncWindow.loadURL(historyUrl);
    }catch(error){
      if(process.argv.includes("--sync-once"))console.error(`Sync setup error: ${error.message}`);
      if(!silent)send("sync:status",{type:"error",message:`Не удалось включить синхронизацию: ${error.message}`});
    }
  })();
  if(!silent)send("sync:status",{type:"info",message:"Если потребуется, войдите в Behaviour Account. Затем Companion сам откроет историю матчей."});
  else setTimeout(()=>{if(!syncWindow.isDestroyed()&&!syncWindow.isVisible())syncWindow.close();},40000);
}

function maybeAutoSync(force=false) {
  if(store.meta?.source!=="official-stats"||statsWindow)return false;
  if(!force&&Date.now()-lastAutoSyncAttempt<45000)return false;
  lastAutoSyncAttempt=Date.now();openStatsSync(true);return true;
}

function gameRunning() {
  return new Promise(resolve=>execFile("powershell.exe",["-NoProfile","-Command","if(Get-Process -ErrorAction SilentlyContinue | Where-Object {$_.ProcessName -match 'DeadByDaylight'}){'yes'}else{'no'}"],{windowsHide:true},(_e,out)=>resolve(out.trim()==="yes")));
}
async function waitForGame(timeoutMs=180000) { const end=Date.now()+timeoutMs; while(Date.now()<end){if(await gameRunning())return true;await sleep(3000);}return false; }
function helperPath(){return app.isPackaged?path.join(process.resourcesPath,"input-helper.ps1"):path.join(__dirname,"input-helper.ps1");}
function runHelper(points){return new Promise((resolve,reject)=>{
  const startedAt=Date.now();logDiagnostic("info","selection-helper-started");
  const args=["-NoProfile","-ExecutionPolicy","Bypass","-File",helperPath(),"-OpenX",String(points.open.x),"-OpenY",String(points.open.y),"-SearchX",String(points.search.x),"-SearchY",String(points.search.y),"-ResultX",String(points.result.x),"-ResultY",String(points.result.y)];
  const child=spawn("powershell.exe",args,{windowsHide:true});let err="";child.stderr.on("data",d=>err+=d.toString());child.on("error",error=>{writeCrashReport("selection-helper-spawn-error",error);reject(error)});child.on("exit",code=>{logDiagnostic(code===0?"info":"error","selection-helper-exit",{code,durationMs:Date.now()-startedAt,stderr:err.trim()});code===0?resolve():reject(new Error(err||`Код ${code}`))});
});}

app.whenReady().then(()=>{
  app.setAppUserModelId("local.fogcompanion.desktop");
  store=loadStore();createMainWindow();createOverlayWindow();createTray();
  setTimeout(()=>refreshStoredProfileAvatar(),900);
  if(process.argv.includes("--sync-once")){setTimeout(()=>openStatsSync(true),1000);setTimeout(()=>app.exit(2),45000);}
  globalShortcut.register("Shift+F2",()=>toggleOverlay());
  ipcMain.handle("data:get",()=>store);
  ipcMain.handle("data:save-settings",(_e,settings)=>{store.settings={...store.settings,...settings};writeStore(store);return store;});
  ipcMain.handle("data:delete-match",(_e,id)=>{store.matches=store.matches.filter(m=>m.id!==id);writeStore(store);return store;});
  ipcMain.handle("stats:open-sync",()=>{openStatsSync();return true;});
  ipcMain.handle("perk:get-details",async(_event,perk,kind)=>{
    try{return await getPerkDetails(perk,kind)}
    catch(error){logDiagnostic("error","item-details-load-failed",{id:perk?.id||"",name:perk?.name||"",kind,error:diagnosticValue(error)});throw error}
  });
  ipcMain.handle("shell:open-external",async(_event,url)=>{if(/^https:\/\//i.test(url||""))await shell.openExternal(url);return true;});
  ipcMain.handle("game:status",()=>gameRunning());
  ipcMain.handle("update:get-status",()=>updateState);
  ipcMain.handle("update:check",()=>checkForUpdates(true));
  ipcMain.handle("update:install",()=>installAvailableUpdate());
  ipcMain.handle("calibration:capture",async(_e,kind)=>{mainWindow.hide();await sleep(3500);const point=screen.getCursorScreenPoint();mainWindow.show();mainWindow.maximize();mainWindow.focus();return{kind,point};});
  ipcMain.handle("game:select",async(_e,payload)=>{
    const {killer,openPoint,searchPoint,resultPoint}=payload||{};
    logDiagnostic("info","killer-selection-requested",{killer:killer?.name||"",gameRunning:"checking"});
    if(!killer||!openPoint||!searchPoint||!resultPoint)throw new Error("Сначала откалибруйте три точки в настройках.");
    let running=await gameRunning();
    if(!running){send("game:selection-status",{type:"info",message:"Запускаю Dead by Daylight через Steam…"});await shell.openExternal("steam://rungameid/381210");running=await waitForGame();if(!running)throw new Error("Игра не запустилась за 3 минуты.");send("game:selection-status",{type:"info",message:"Игра запущена. Жду загрузку лобби…"});await sleep(35000);}
    const oldClipboard=clipboard.readText();clipboard.writeText(killer.search||killer.name);if(overlayWindow&&!overlayWindow.isDestroyed())overlayWindow.hide();await sleep(25);
    try{await runHelper({open:openPoint,search:searchPoint,result:resultPoint});logDiagnostic("info","killer-selection-complete",{killer:killer.name});return true;}
    catch(error){writeCrashReport("killer-selection-failed",error,{killer:killer.name});throw error;}
    finally{clipboard.writeText(oldClipboard);}
  });
  ipcMain.on("overlay:hide",()=>{if(overlayWindow&&!overlayWindow.isDestroyed())overlayWindow.hide();});
  ipcMain.on("window:minimize",()=>mainWindow.minimize());
  ipcMain.on("window:maximize",()=>mainWindow.isMaximized()?mainWindow.unmaximize():mainWindow.maximize());
  ipcMain.on("window:close",()=>mainWindow.close());
  setTimeout(()=>maybeAutoSync(true),6000);
  setTimeout(()=>checkForUpdates(false),3500);
  setInterval(()=>maybeAutoSync(),60000);
  setInterval(()=>checkForUpdates(false),6*60*60*1000);
});

app.on("render-process-gone",(_event,webContents,details)=>{if(!app.isQuitting&&details.reason!=="clean-exit")logDiagnostic("error","render-process-gone",{url:webContents?.getURL?.()||"",...details})});
app.on("child-process-gone",(_event,details)=>{if(!app.isQuitting&&details.reason!=="clean-exit")writeCrashReport("child-process-gone",new Error(`Child process: ${details.reason}`),details)});
app.on("before-quit",()=>{app.isQuitting=true;finishDiagnosticSession("before-quit")});
app.on("activate",showMainWindow);
app.on("will-quit",()=>{globalShortcut.unregisterAll();if(tray){tray.destroy();tray=null;}});
