const { app, BrowserWindow, ipcMain, globalShortcut, screen, clipboard, shell, Tray, Menu, crashReporter, net, session } = require("electron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const { spawn, execFile } = require("child_process");

const updateWorkerFlag="--fog-apply-update";
const updateWorkerIndex=process.argv.indexOf(updateWorkerFlag);
let updateWorkerRequest=null;
if(updateWorkerIndex>=0)try{updateWorkerRequest=JSON.parse(Buffer.from(String(process.argv[updateWorkerIndex+1]||""),"base64url").toString("utf8"))}catch{}
const hasSingleInstanceLock=updateWorkerRequest?true:app.requestSingleInstanceLock();
if(!hasSingleInstanceLock)app.quit();

const diagnosticsDir=path.join(app.getPath("userData"),"diagnostics");
const crashDumpDir=path.join(diagnosticsDir,"dumps");
const runtimeDir=path.join(app.getPath("userData"),"runtime");
const runtimeInputHelper=path.join(runtimeDir,"input-helper.ps1");
const sessionMarker=path.join(diagnosticsDir,"active-session.json");
const sessionId=`${new Date().toISOString().replace(/[:.]/g,"-")}-${process.pid}`;
if(hasSingleInstanceLock&&!updateWorkerRequest){fs.mkdirSync(crashDumpDir,{recursive:true});app.setPath("crashDumps",crashDumpDir);crashReporter.start({productName:"Fog Companion",uploadToServer:false,extra:{version:app.getVersion(),sessionId}})}

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
async function openDiagnosticsFolder(){
  fs.mkdirSync(diagnosticsDir,{recursive:true});
  const error=await shell.openPath(diagnosticsDir);
  if(error){logDiagnostic("error","open-diagnostics-failed",{error});throw new Error(error)}
  return diagnosticsDir;
}
function ensureInputHelper(){
  fs.mkdirSync(runtimeDir,{recursive:true});
  const bundledCandidates=[path.join(process.resourcesPath,"input-helper.ps1"),path.join(__dirname,"input-helper.ps1")];
  const bundled=bundledCandidates.find(candidate=>fs.existsSync(candidate));
  if(bundled){
    const source=fs.readFileSync(bundled);
    const current=fs.existsSync(runtimeInputHelper)?fs.readFileSync(runtimeInputHelper):null;
    if(!current||!source.equals(current)){
      fs.writeFileSync(runtimeInputHelper,source);
      logDiagnostic("info","selection-helper-installed",{sourcePath:bundled,destination:runtimeInputHelper,bytes:source.length});
    }
  }
  if(!fs.existsSync(runtimeInputHelper)){
    const error=new Error("Служебный файл автовыбора не найден. Переустановите актуальную версию Fog Companion.");
    writeCrashReport("selection-helper-missing",error,{bundledCandidates,runtimeInputHelper});
    throw error;
  }
  return runtimeInputHelper;
}
function decodePowerShellOutput(value){
  const buffer=Buffer.isBuffer(value)?value:Buffer.concat(value||[]);
  if(!buffer.length)return"";
  const utf8=buffer.toString("utf8");
  if(!utf8.includes("�"))return utf8.trim();
  const variants=["ibm866","windows-1251"].map(encoding=>{try{return new TextDecoder(encoding).decode(buffer)}catch{return""}}).filter(Boolean);
  return variants.sort((left,right)=>(right.match(/[А-Яа-яЁё]/g)||[]).length-(left.match(/[А-Яа-яЁё]/g)||[]).length)[0]?.trim()||utf8.trim();
}
function beginDiagnosticSession(){
  try{if(fs.existsSync(sessionMarker)){const previous=JSON.parse(fs.readFileSync(sessionMarker,"utf8"));writeCrashReport("unclean-shutdown",new Error("Предыдущая сессия завершилась без штатного выхода."),{previous})}fs.writeFileSync(sessionMarker,JSON.stringify({sessionId,pid:process.pid,startedAt:diagnosticStamp(),version:app.getVersion()},null,2),"utf8");logDiagnostic("info","app-start",{version:app.getVersion(),packaged:app.isPackaged})}catch(error){logDiagnostic("error","diagnostics-init-failed",error)}
}
function finishDiagnosticSession(reason){logDiagnostic("info","app-exit",{reason});try{if(fs.existsSync(sessionMarker))fs.unlinkSync(sessionMarker)}catch(error){logDiagnostic("error","session-marker-remove-failed",error)}}

if(hasSingleInstanceLock&&!updateWorkerRequest){process.on("uncaughtException",error=>{writeCrashReport("uncaught-exception",error);app.isQuitting=true;try{app.exit(1)}catch{process.exit(1)}});process.on("unhandledRejection",reason=>writeCrashReport("unhandled-rejection",reason));beginDiagnosticSession()}

let mainWindow;
let overlayWindow;
let statsWindow;
let steamAuthWindow;
let steamAuthPromise;
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
const githubPackageManifest = `https://raw.githubusercontent.com/${githubRepository}/main/package.json`;
const appIcon = () => path.join(__dirname,"assets","fog-companion.ico");
let updateState={status:"idle",currentVersion:app.getVersion(),latestVersion:"",message:"Обновления еще не проверялись.",downloadUrl:"",checksumUrl:""};

const versionParts=value=>String(value||"").replace(/^v/i,"").split(/[.-]/).slice(0,3).map(part=>Number.parseInt(part,10)||0);
function isNewerVersion(candidate,current){const next=versionParts(candidate),installed=versionParts(current);for(let index=0;index<3;index++){if(next[index]!==installed[index])return next[index]>installed[index]}return false}
function publishUpdateState(next){updateState={...updateState,...next,currentVersion:app.getVersion()};send("update:status",updateState);return updateState}
const githubHeaders=()=>({Accept:"application/vnd.github+json","User-Agent":`Fog-Companion/${app.getVersion()}`,"X-GitHub-Api-Version":"2022-11-28"});
const networkErrorMessage=error=>{const code=error?.cause?.code||error?.code||"";return `${error?.message||String(error)}${code?` (${code})`:""}`};
async function githubResponse(url,{attempts=4,timeoutMs=30000}={}){
  let lastError;
  for(let attempt=1;attempt<=attempts;attempt++){
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const response=await net.fetch(url,{headers:githubHeaders(),redirect:"follow",signal:controller.signal,bypassCustomProtocolHandlers:true});
      if(response.ok)return response;
      const error=new Error(`GitHub ответил ${response.status}`);error.retryable=[408,425,429].includes(response.status)||response.status>=500;
      if(!error.retryable)throw error;
      lastError=error;
    }catch(error){
      if(error?.retryable===false)throw error;
      lastError=error;
      logDiagnostic("warn","update-network-attempt-failed",{url,attempt,attempts,online:typeof net.isOnline==="function"?net.isOnline():null,error:networkErrorMessage(error)});
    }finally{clearTimeout(timeout)}
    if(attempt<attempts)await sleep(500*2**(attempt-1));
  }
  throw new Error(`Не удалось связаться с GitHub после ${attempts} попыток: ${networkErrorMessage(lastError)}`);
}
async function latestReleaseInfo(){
  try{
    const release=await (await githubResponse(githubLatestReleaseApi)).json(),latest=String(release?.tag_name||release?.name||"").replace(/^v/i,""),assets=Array.isArray(release?.assets)?release.assets:[],assetName=asset=>String(asset?.name||"").replace(/[._-]+/g," ").replace(/\s+/g," ").trim().toLowerCase(),executable=assets.find(asset=>assetName(asset)==="fog companion exe"),checksum=assets.find(asset=>assetName(asset)==="fog companion exe sha256");
    if(!latest||!executable?.browser_download_url||!checksum?.browser_download_url)throw new Error("В последнем релизе отсутствуют EXE или SHA-256.");
    return{latest,downloadUrl:executable.browser_download_url,checksumUrl:checksum.browser_download_url,source:"api"};
  }catch(apiError){
    logDiagnostic("warn","update-release-api-fallback",{error:networkErrorMessage(apiError)});
    const manifest=await (await githubResponse(githubPackageManifest)).json(),latest=String(manifest?.version||"").replace(/^v/i,"");
    if(!/^\d+\.\d+\.\d+$/.test(latest))throw apiError;
    const base=`https://github.com/${githubRepository}/releases/download/v${latest}`;
    return{latest,downloadUrl:`${base}/Fog-Companion.exe`,checksumUrl:`${base}/Fog-Companion.exe.sha256`,source:"manifest"};
  }
}
async function checkForUpdates(manual=false){
  publishUpdateState({status:"checking",message:"Проверяю GitHub Releases…"});
  try{
    const {latest,downloadUrl,checksumUrl,source}=await latestReleaseInfo();
    logDiagnostic("info","update-check-complete",{currentVersion:app.getVersion(),latestVersion:latest,source});
    if(!isNewerVersion(latest,app.getVersion()))return publishUpdateState({status:"current",latestVersion:latest,message:`Установлена актуальная версия ${app.getVersion()}.`,downloadUrl:"",checksumUrl:""});
    logDiagnostic("info","update-available",{currentVersion:app.getVersion(),latestVersion:latest,source});
    const state=publishUpdateState({status:"available",latestVersion:latest,message:`Доступна версия ${latest}.`,downloadUrl,checksumUrl});
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
  const stagedExecutable=path.join(stagingDir,`Fog-Companion-${updateState.latestVersion}.exe`);
  try{
    const [binaryResponse,checksumResponse]=await Promise.all([githubResponse(updateState.downloadUrl),githubResponse(updateState.checksumUrl)]),binary=Buffer.from(await binaryResponse.arrayBuffer()),checksumText=await checksumResponse.text(),expected=(checksumText.match(/\b[a-f0-9]{64}\b/i)||[])[0]?.toUpperCase();
    if(!expected)throw new Error("Релиз не содержит корректную контрольную сумму.");
    const actual=crypto.createHash("sha256").update(binary).digest("hex").toUpperCase();
    if(actual!==expected)throw new Error("Контрольная сумма обновления не совпала. Установка отменена.");
    fs.writeFileSync(stagedExecutable,binary);
    publishUpdateState({status:"installing",message:"Обновление проверено. Запускаю установщик…"});
    logDiagnostic("info","update-worker-starting",{fromVersion:app.getVersion(),toVersion:updateState.latestVersion,source:stagedExecutable,destination:portableExecutable});
    const workerPayload=Buffer.from(JSON.stringify({source:stagedExecutable,destination:portableExecutable,expected,previousPid:process.pid,version:updateState.latestVersion}),"utf8").toString("base64url");
    const child=spawn(stagedExecutable,[updateWorkerFlag,workerPayload],{detached:true,stdio:"ignore",windowsHide:true});
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("Не удалось запустить установщик обновления.")),8000);child.once("spawn",()=>{clearTimeout(timer);resolve()});child.once("error",error=>{clearTimeout(timer);reject(error)})});
    child.unref();
    publishUpdateState({status:"installing",message:"Установщик запущен. Перезапускаю Companion…"});
    app.isQuitting=true;
    setTimeout(()=>app.quit(),250);
    return true;
  }catch(error){logDiagnostic("error","update-install-failed",{error:diagnosticValue(error)});publishUpdateState({status:"available",message:`Не удалось установить обновление: ${error.message}`});throw error}
}

async function runUpdateWorker(request){
  const source=path.resolve(String(request?.source||"")),destination=path.resolve(String(request?.destination||"")),expected=String(request?.expected||"").toUpperCase(),backup=`${destination}.previous`,deadline=Date.now()+90000;
  if(!source||!destination||!/^[A-F0-9]{64}$/.test(expected))throw new Error("Некорректные параметры установщика обновления.");
  const sourceHash=crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex").toUpperCase();
  if(sourceHash!==expected)throw new Error("Контрольная сумма скачанного обновления не совпала.");
  logDiagnostic("info","update-worker-ready",{source,destination,previousPid:request.previousPid,version:request.version});
  let lastError=null,backupReady=false;
  while(Date.now()<deadline){
    try{
      if(!backupReady&&fs.existsSync(destination)){fs.copyFileSync(destination,backup);backupReady=true}
      fs.copyFileSync(source,destination);
      const installed=crypto.createHash("sha256").update(fs.readFileSync(destination)).digest("hex").toUpperCase();
      if(installed!==expected)throw new Error("Проверка установленного portable-файла не прошла.");
      logDiagnostic("info","update-worker-installed",{destination,backup:backupReady?backup:"",version:request.version});
      await new Promise(resolve=>setTimeout(resolve,1500));
      logDiagnostic("info","update-worker-relaunching",{destination,version:request.version});
      const relaunched=spawn(destination,[],{detached:true,stdio:"ignore",windowsHide:true});
      await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("Новая версия не запустилась после установки.")),8000);relaunched.once("spawn",()=>{clearTimeout(timer);resolve()});relaunched.once("error",error=>{clearTimeout(timer);reject(error)})});
      relaunched.unref();
      logDiagnostic("info","update-worker-relaunched",{destination,version:request.version});
      return true;
    }catch(error){lastError=error;await new Promise(resolve=>setTimeout(resolve,500))}
  }
  if(backupReady&&fs.existsSync(backup))try{fs.copyFileSync(backup,destination)}catch{}
  throw lastError||new Error("Portable-файл оставался занят дольше 90 секунд.");
}

function demoParticipant(role, character, result, score, perks, number) {
  return { role, character:{ name:character, image:"" }, nickname: role === "killer" ? "Игрок" : `Выживший ${number}`,
    result, score, perks:perks.map(name => ({name,image:""})), addOns:[], offering:null, power:null, emblems:[] };
}

function defaultData() {
  const now = Math.floor(Date.now()/1000);
  return {
    version:1,
    account:null,
    profile:{ name:"Игрок", platform:"Behaviour" },
    meta:{ demo:true, lastSync:null, source:"demo", behaviourAuthenticated:false },
    settings:{ automationEnabled:false, searchPoint:null, resultPoint:null, perkSlot1Point:null, perkSlot2Point:null, perkSlot3Point:null, perkSlot4Point:null, perkSearchPoint:null, perkResultPoint:null, wheelCooldown:3, perkCooldown:3, enabledKillerIds:null, enabledPerkIds:null, killerFilterInitialized:false, perkFilterInitialized:false },
    randomizer:{ killer:null, perks:[], perkLocks:[false,false,false,false], killerHistory:[], perkHistory:[] },
    perkCatalog:{ items:[], syncedAt:null },
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
  try {
    const value=JSON.parse(fs.readFileSync(dataFile(), "utf8"));
    if(!Object.hasOwn(value,"account"))value.account=null;
    if(!value.behaviourProfile&&value.profile)value.behaviourProfile=value.profile;
    value.settings={...defaultData().settings,...(value.settings||{})};
    if(!value.settings.killerFilterInitialized&&Array.isArray(value.settings.enabledKillerIds)&&!value.settings.enabledKillerIds.length)value.settings.enabledKillerIds=null;
    value.randomizer={...defaultData().randomizer,...(value.randomizer||{})};
    value.meta={...defaultData().meta,...(value.meta||{})};
    value.perkCatalog={...defaultData().perkCatalog,...(value.perkCatalog||{})};
    return refreshMatchKillCounts(value);
  }
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
    match.kills=survivors.filter(person=>person.result&&!escaped(person)).length;
  }
  return value;
}

function applyAuthenticatedIdentity(value=store){
  const account=value?.account;
  if(account?.provider!=="steam"||!account.steamId)return false;
  const name=String(account.name||"").trim()||`Steam ${String(account.steamId).slice(-6)}`;
  const profileUrl=String(account.profileUrl||"").trim()||`https://steamcommunity.com/profiles/${account.steamId}`;
  let changed=false;
  for(const match of value.matches||[]){
    const player=match?.player;
    if(!player)continue;
    if(!player.trackerNickname&&player.nickname&&player.nickname!==name){
      player.trackerNickname=player.nickname;
      changed=true;
    }
    const identity={nickname:name,profileUrl,identityProvider:"steam",steamId:String(account.steamId)};
    for(const [key,next] of Object.entries(identity)){
      if(player[key]===next)continue;
      player[key]=next;
      changed=true;
    }
  }
  return changed;
}

function writeStore(value) {
  const target=dataFile(); fs.mkdirSync(path.dirname(target),{recursive:true});
  const temporary=`${target}.tmp`; fs.writeFileSync(temporary,JSON.stringify(value,null,2),"utf8");
  try { fs.renameSync(temporary,target); }
  catch { fs.copyFileSync(temporary,target); fs.unlinkSync(temporary); }
}

function send(channel,value) { if(mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel,value); }
function sendRandomizerState(){
  if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send("randomizer:updated",store);
  if(overlayWindow&&!overlayWindow.isDestroyed())overlayWindow.webContents.send("randomizer:updated",store);
}

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
const steamOpenIdEndpoint="https://steamcommunity.com/openid/login";
const steamAuthPartition="persist:fog-companion-steam-auth";
function xmlValue(xml,tag){
  const match=String(xml||"").match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`,"i"));
  return decodeHtml(String(match?.[1]||"").replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/,"$1")).trim();
}
async function steamPublicProfile(steamId,fallback={}){
  const profileUrl=`https://steamcommunity.com/profiles/${steamId}`;
  try{
    const response=await net.fetch(`${profileUrl}/?xml=1`,{headers:{"User-Agent":`Fog-Companion/${app.getVersion()}`},redirect:"follow",bypassCustomProtocolHandlers:true});
    if(!response.ok)throw new Error(`Steam ответил ${response.status}`);
    const xml=await response.text(),name=xmlValue(xml,"steamID"),avatar=xmlValue(xml,"avatarFull")||xmlValue(xml,"avatarMedium");
    return{name:name||fallback.name||`Steam ${steamId.slice(-6)}`,avatar:avatar||fallback.avatar||"",profileUrl:fallback.profileUrl||profileUrl};
  }catch(error){
    logDiagnostic("warn","steam-profile-load-failed",{steamId,error:diagnosticValue(error)});
    return{name:fallback.name||`Steam ${steamId.slice(-6)}`,avatar:fallback.avatar||"",profileUrl:fallback.profileUrl||profileUrl};
  }
}
async function verifySteamOpenId(callbackUrl,expectedReturnTo,expectedState){
  const callback=new URL(callbackUrl);
  if(callback.searchParams.get("state")!==expectedState)throw new Error("Steam вернул неверный идентификатор сеанса.");
  if(callback.searchParams.get("openid.mode")==="cancel")throw new Error("Вход через Steam отменён.");
  if(callback.searchParams.get("openid.mode")!=="id_res")throw new Error("Steam не подтвердил вход.");
  if(callback.searchParams.get("openid.return_to")!==expectedReturnTo)throw new Error("Steam вернул неверный адрес подтверждения.");
  const verification=new URLSearchParams();
  for(const [key,value] of callback.searchParams)if(key.startsWith("openid."))verification.set(key,value);
  verification.set("openid.mode","check_authentication");
  const response=await net.fetch(steamOpenIdEndpoint,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","User-Agent":`Fog-Companion/${app.getVersion()}`},body:verification.toString(),bypassCustomProtocolHandlers:true});
  if(!response.ok)throw new Error(`Steam не подтвердил подпись: HTTP ${response.status}.`);
  const answer=await response.text();
  if(!/(?:^|\n)is_valid\s*:\s*true(?:\r?$|\n)/im.test(answer))throw new Error("Подпись Steam OpenID недействительна.");
  const claimed=callback.searchParams.get("openid.claimed_id")||"",match=claimed.match(/^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/i);
  if(!match)throw new Error("Steam не вернул корректный SteamID.");
  return match[1];
}
function createSteamAuthFlow(){
  return new Promise((resolve,reject)=>{
    const authState=crypto.randomBytes(24).toString("hex");
    let settled=false,verifying=false,callbackServer=null,returnTo="",callbackOrigin="";
    const finish=(error,value)=>{
      if(settled)return;settled=true;
      if(callbackServer){callbackServer.close();callbackServer=null}
      if(steamAuthWindow&&!steamAuthWindow.isDestroyed())steamAuthWindow.close();steamAuthWindow=null;
      error?reject(error):resolve(value);
    };
    const timer=setTimeout(()=>finish(new Error("Время ожидания входа через Steam истекло.")),5*60*1000);
    const complete=async target=>{
      if(verifying)return;verifying=true;send("auth:status",{type:"info",message:"Проверяю подпись Steam…"});
      try{
        const steamId=await verifySteamOpenId(target,returnTo,authState),publicProfile=await steamPublicProfile(steamId);
        store.account={provider:"steam",steamId,name:publicProfile.name,avatar:publicProfile.avatar,profileUrl:publicProfile.profileUrl,authenticatedAt:Date.now()};
        applyAuthenticatedIdentity(store);
        writeStore(store);logDiagnostic("info","steam-auth-complete",{steamId});send("sync:status",{type:"success",message:`Выполнен вход через Steam: ${publicProfile.name}`,data:store});clearTimeout(timer);finish(null,store);
      }catch(error){logDiagnostic("warn","steam-auth-failed",{error:diagnosticValue(error)});clearTimeout(timer);finish(error)}
    };
    const handleNavigation=(event,target)=>{
      let url;try{url=new URL(target)}catch{return}
      if(url.origin===callbackOrigin&&url.pathname==="/steam/callback")return;
      if(url.protocol!=="https:"||url.hostname!=="steamcommunity.com"){event.preventDefault();logDiagnostic("warn","steam-auth-navigation-blocked",{target})}
    };
    callbackServer=http.createServer((request,response)=>{
      const chunks=[];
      request.on("data",chunk=>chunks.push(chunk));
      request.on("end",()=>{
        let callback;
        try{callback=new URL(request.url,callbackOrigin)}catch{response.writeHead(400);response.end();return}
        if(callback.pathname!=="/steam/callback"){response.writeHead(404);response.end();return}
        if(request.method==="POST"){
          const body=new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
          body.forEach((value,key)=>callback.searchParams.set(key,value));
        }
        response.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Connection":"close"});
        response.end('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="color-scheme" content="dark"><title>Fog Companion</title><style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#171a21;color:#f1f1f1;font:16px system-ui}.box{text-align:center}.mark{color:#d63645;font-size:42px}small{color:#9aa0a8}</style><div class="box"><div class="mark">&#10003;</div><h2>Steam подтвердил вход</h2><small>Fog Companion проверяет подпись аккаунта…</small></div>');
        logDiagnostic("info","steam-auth-callback-received",{method:request.method});
        void complete(callback.toString());
      });
    });
    callbackServer.once("error",error=>{clearTimeout(timer);finish(new Error(`Не удалось запустить локальный вход Steam: ${error.message}`))});
    callbackServer.listen(0,"127.0.0.1",()=>{
      const address=callbackServer.address();
      if(!address||typeof address==="string"){clearTimeout(timer);finish(new Error("Не удалось получить локальный адрес входа Steam."));return}
      callbackOrigin=`http://127.0.0.1:${address.port}`;
      returnTo=`${callbackOrigin}/steam/callback?state=${authState}`;
      const parameters=new URLSearchParams({"openid.ns":"http://specs.openid.net/auth/2.0","openid.mode":"checkid_setup","openid.return_to":returnTo,"openid.realm":`${callbackOrigin}/`,"openid.identity":"http://specs.openid.net/auth/2.0/identifier_select","openid.claimed_id":"http://specs.openid.net/auth/2.0/identifier_select"}),loginUrl=`${steamOpenIdEndpoint}?${parameters}`;
      steamAuthWindow=new BrowserWindow({parent:mainWindow||undefined,modal:Boolean(mainWindow),width:760,height:820,minWidth:620,minHeight:680,show:true,title:"Вход через Steam — Fog Companion",autoHideMenuBar:true,backgroundColor:"#171a21",icon:appIcon(),webPreferences:{partition:steamAuthPartition,contextIsolation:true,nodeIntegration:false,sandbox:true}});
      steamAuthWindow.center();steamAuthWindow.show();steamAuthWindow.focus();
      steamAuthWindow.webContents.on("will-redirect",handleNavigation);steamAuthWindow.webContents.on("will-navigate",handleNavigation);steamAuthWindow.webContents.setWindowOpenHandler(()=>({action:"deny"}));
      steamAuthWindow.webContents.on("did-finish-load",()=>{if(steamAuthWindow&&!steamAuthWindow.isDestroyed()){steamAuthWindow.show();steamAuthWindow.focus()}});
      steamAuthWindow.webContents.on("did-fail-load",(_event,code,description,target,isMainFrame)=>{if(isMainFrame&&!(target||"").startsWith(callbackOrigin))logDiagnostic("warn","steam-auth-page-failed",{code,description,target})});
      steamAuthWindow.on("closed",()=>{steamAuthWindow=null;clearTimeout(timer);if(!settled)finish(new Error("Окно входа через Steam закрыто."))});
      steamAuthWindow.loadURL(loginUrl).catch(error=>{clearTimeout(timer);finish(new Error(`Не удалось открыть Steam: ${error.message}`))});
    });
  });
}
function loginWithSteam(){
  if(steamAuthPromise){if(steamAuthWindow&&!steamAuthWindow.isDestroyed()){steamAuthWindow.show();steamAuthWindow.focus()}return steamAuthPromise}
  logDiagnostic("info","steam-auth-started");send("auth:status",{type:"info",message:"Открылось защищённое окно Steam. Завершите вход в нём."});
  steamAuthPromise=createSteamAuthFlow();steamAuthPromise.finally(()=>{steamAuthPromise=null}).catch(()=>{});return steamAuthPromise;
}
async function logoutAccount(){
  const previous=store.account;store.account=null;writeStore(store);
  await session.fromPartition(steamAuthPartition).clearStorageData({storages:["cookies"]}).catch(()=>{});
  logDiagnostic("info","account-logout",{provider:previous?.provider||"",steamId:previous?.steamId||""});send("sync:status",{type:"info",message:"Вы вышли из профиля Fog Companion.",data:store});return store;
}
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
  const account=store.account;
  if(account?.provider!=="steam"||!account.steamId)return false;
  const current=await steamPublicProfile(account.steamId,account),next={...account,...current};
  if(JSON.stringify(account)===JSON.stringify(next))return false;
  store.account=next;applyAuthenticatedIdentity(store);writeStore(store);send("sync:status",{type:"silent",message:"",data:store});return true;
}

const addonIndexPages=["Фонарик (улучшения)","Аптечка (улучшения)","Ящик с инструментами (улучшения)","Карта (улучшения)","Ключ (улучшения)"];
const wikiOrigin="https://dead-by-daylight.fandom.com";
const killerPerkIndexPage="Навыки убийц";
const killerPerkCategory="Категория:Умения Убийц";
const perkCatalogSchema=3;
const perkWikiAliases={
  "Смотри, они бегут":"Поиграть со своей жертвой","Пусть ждут":"Оставьте лучшее напоследок","Истребление слабых":"Угасающий свет",
  "Все средства хороши":"Мертвая хватка (сенобит)","Порча: шут судьбы":"Порча: игрушка","Секущий крюк: сочащиеся раны":"Секущий крюк: дар боли",
  "Секущий крюк «Пучина ярости»":"Секущий крюк: пучина ярости"
};
const perkNameAliases={Dying_Light:"Угасающий свет",DyingLight:"Угасающий свет",DecisiveStrike:"Решающий удар",ObjectOfObsession:"Объект одержимости"};
function perkDisplayTitle(value){return String(value||"").replace(/\s+\(сенобит\)$/i,"").trim()}
function localizePerkItem(item){if(!item)return item;const aliasTitle=perkWikiAliases[String(item.name||"")]||"",wikiTitle=item.wikiTitle||aliasTitle||item.name,name=perkNameAliases[String(item.id||"")]||perkNameAliases[String(item.name||"")]||perkDisplayTitle(wikiTitle);return{...item,name,wikiTitle}}
function normalizedPerkName(value){return String(value||"").trim().toLocaleLowerCase("ru-RU").replace(/ё/g,"е")}
function isRealKillerPerkItem(item){const name=normalizedPerkName(item?.name);return Boolean(name)&&!new Set(["навыки убийц","навыки убийцы","умения убийц","умения убийцы"]).has(name)&&!/\(класс\)$/.test(name)}
function perkIdentity(item){return normalizedPerkName(localizePerkItem(item)?.wikiTitle||localizePerkItem(item)?.name)}
function canonicalizePerkItems(items){const result=new Map();for(const raw of Array.isArray(items)?items:[]){const item=localizePerkItem(raw);if(!isRealKillerPerkItem(item))continue;const key=perkIdentity(item),previous=result.get(key);result.set(key,previous?{...item,...previous,name:item.name||previous.name,image:previous.image||item.image||""}:item)}return [...result.values()].sort((a,b)=>a.name.localeCompare(b.name,"ru")||perkIdentity(a).localeCompare(perkIdentity(b),"ru"))}
function wikiAttribute(attrs,name){const match=String(attrs||"").match(new RegExp(`(?:^|\\s)${name}="([^"]+)"`,"i"));return match?decodeHtml(match[1]):""}
function killerPerksFromIndexHtml(html){
  const source=String(html||""),start=source.indexOf('id="Уникальные_навыки_убийц"'),scope=start>=0?source.slice(start):source,items=[],seen=new Set();
  for(const match of scope.matchAll(/<a\b([^>]*)>\s*<img\b([^>]*)>/gi)){
    const linkAttrs=match[1],imageAttrs=match[2],name=wikiAttribute(linkAttrs,"title"),href=wikiAttribute(linkAttrs,"href");
    const image=wikiAttribute(imageAttrs,"data-src")||wikiAttribute(imageAttrs,"src");
    if(!name||!image||image.startsWith("data:")||!/^\/ru\/wiki\//i.test(href)||seen.has(normalizedPerkName(name)))continue;
    const item=localizePerkItem({id:`wiki-perk:${normalizedPerkName(name)}`,name:perkDisplayTitle(name),wikiTitle:name,image});
    if(!isRealKillerPerkItem(item))continue;
    seen.add(normalizedPerkName(name));items.push(item);
  }
  return canonicalizePerkItems(items);
}
function killerPerksFromCategoryPages(pages){
  return canonicalizePerkItems((Array.isArray(pages)?pages:[]).map(page=>localizePerkItem({
    id:`wiki-${page.pageid}`,
    name:String(page.title||"").trim(),
    image:page.thumbnail?.source||page.original?.source||""
  })).filter(item=>item.image&&isRealKillerPerkItem(item)));
}
function mergePerkCatalogImages(items,imageItems){
  const imageByIdentity=new Map(canonicalizePerkItems(imageItems).map(item=>[perkIdentity(item),item.image]));
  return canonicalizePerkItems(canonicalizePerkItems(items).map(item=>({...item,image:imageByIdentity.get(perkIdentity(item))||item.image||""})));
}
function applyPerkCatalog(items,previousItems=[]){
  const catalog=canonicalizePerkItems(items),byIdentity=new Map(catalog.map(item=>[perkIdentity(item),item])),oldById=new Map(canonicalizePerkItems(previousItems).map(item=>[String(item.id),item]));
  const resolve=item=>byIdentity.get(perkIdentity(item))||catalog.find(candidate=>normalizedPerkName(candidate.name)===normalizedPerkName(localizePerkItem(item)?.name));
  if(store.settings.perkFilterInitialized&&Array.isArray(store.settings.enabledPerkIds)){
    const enabledNames=new Set(store.settings.enabledPerkIds.map(id=>oldById.get(String(id))).filter(Boolean).map(perkIdentity));
    store.settings.enabledPerkIds=catalog.filter(item=>enabledNames.has(perkIdentity(item))||store.settings.enabledPerkIds.includes(item.id)).map(item=>item.id);
  }else{store.settings.enabledPerkIds=catalog.map(item=>item.id);store.settings.perkFilterInitialized=true}
  if(Array.isArray(store.randomizer?.perks))store.randomizer.perks=store.randomizer.perks.map(item=>resolve(item)||null);
  if(Array.isArray(store.randomizer?.perkHistory))store.randomizer.perkHistory=store.randomizer.perkHistory.map(group=>Array.isArray(group)?group.map(id=>oldById.get(String(id))).map(resolve).filter(Boolean).map(item=>item.id):group);
  return catalog;
}
async function requestWikiJson(url,{attempts=3}={}){
  let lastError;
  for(let attempt=1;attempt<=attempts;attempt++){
    try{
      const response=await net.fetch(url,{headers:{"User-Agent":`Fog-Companion/${app.getVersion()}`},redirect:"follow",signal:AbortSignal.timeout(12000),bypassCustomProtocolHandlers:true});
      if(!response.ok)throw new Error(`Каталог перков ответил ${response.status}`);
      return await response.json();
    }catch(error){lastError=error;logDiagnostic("warn","perk-catalog-request-retry",{attempt,error:diagnosticValue(error)});if(attempt<attempts)await sleep(attempt*450)}
  }
  throw lastError||new Error("Каталог перков временно недоступен");
}
async function getKillerPerkCatalog(){
  const rawCached=Array.isArray(store.perkCatalog?.items)?store.perkCatalog.items:[],cached=canonicalizePerkItems(rawCached);
  if(store.perkCatalog?.schemaVersion===perkCatalogSchema&&cached.length>=100&&Date.now()-Number(store.perkCatalog.syncedAt||0)<7*24*60*60*1000){
    return cached;
  }
  const indexQuery=new URLSearchParams({action:"parse",page:killerPerkIndexPage,prop:"text",format:"json",formatversion:"2",origin:"*"});
  const imageQuery=new URLSearchParams({action:"query",generator:"categorymembers",gcmtitle:killerPerkCategory,gcmtype:"page",gcmlimit:"max",prop:"pageimages",piprop:"thumbnail|original",pithumbsize:"256",format:"json",formatversion:"2",origin:"*"});
  try{
    const [indexPayload,imagePayload]=await Promise.all([
      requestWikiJson(`${wikiOrigin}/ru/api.php?${indexQuery}`),
      requestWikiJson(`${wikiOrigin}/ru/api.php?${imageQuery}`)
    ]);
    const namedPerks=killerPerksFromIndexHtml(indexPayload?.parse?.text);
    const currentImages=killerPerksFromCategoryPages(imagePayload?.query?.pages);
    const parsed=mergePerkCatalogImages(namedPerks,currentImages),items=applyPerkCatalog(parsed,rawCached);
    if(items.length<100)throw new Error(`Таблица Wiki вернула только ${items.length} перков`);
    store.perkCatalog={items,syncedAt:Date.now(),schemaVersion:perkCatalogSchema,source:"wiki-killer-perks-index+pageimages"};
    writeStore(store);return items;
  }catch(error){
    if(cached.length){const items=applyPerkCatalog(cached,rawCached);store.perkCatalog={...(store.perkCatalog||{}),items};writeStore(store);return items}
    throw error;
  }
}
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
  for(const candidate of [...new Set((isAddon?[]:[perk?.wikiTitle,name,normalizedWikiName,preferred]).filter(Boolean))]){
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
    characterClass:normalizeItem(raw.characterClass),
    result,
    score:Number(raw.leaderboardScore||raw.score||0),
    perks:(loadout.perks||[]).map(normalizeItem).filter(Boolean),
    addOns:(loadout.addOns||loadout.addons||[]).map(normalizeItem).filter(Boolean),
    offering:normalizeItem(loadout.offering), power:normalizeItem(loadout.power||loadout.item||loadout.inventoryItem),
    emblems:(raw.emblems||[]).map(e=>({id:e.emblem_id||e.id||"",name:e.emblem_name||e.name||"",quality:e.emblem_quality||e.quality||""}))
  };
}

function escaped(participant) { return /escape|escaped|hatch|gate|сбеж/i.test(participant.result||""); }
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
      // Для статистики убийцы любой подтвержденный исход, кроме побега, считается убийством.
      kills:player.role==="killer" ? survivors.filter(p=>p.result && !escaped(p)).length : null
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
  store.meta={...(store.meta||{}),demo:false,lastSync:Date.now(),source:"official-stats",behaviourAuthenticated:true}; applyAuthenticatedIdentity(store); writeStore(store);
  send("sync:status",{type:silent?"silent":"success",message:silent?"":`Импортировано матчей: ${imported.length}`,data:store});
  return imported.length;
}

async function importProfile(payload,{silent=false}={}) {
  if(!payload||typeof payload!=="object")return false;
  store.meta={...(store.meta||{}),behaviourAuthenticated:true};
  const accounts=Array.isArray(payload.accounts)?payload.accounts:[];
  const account=accounts.find(item=>item.type==="steam"&&item.avatarUrl)||accounts.find(item=>item.avatarUrl)||accounts[0]||{};
  const next={
    name:payload.nickName||account.userName||store.behaviourProfile?.name||"Игрок DBD",
    platform:String(account.type||store.behaviourProfile?.platform||"Behaviour").toUpperCase(),
    avatar:await currentSteamAvatar(account),
    profileUrl:account.profileUrl||""
  };
  if(JSON.stringify(store.behaviourProfile||{})===JSON.stringify(next)){writeStore(store);return false;}
  store.behaviourProfile=next;writeStore(store);
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
    {label:"Открыть папку с логами",click:()=>openDiagnosticsFolder().catch(()=>{})},
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
  if(!store?.account){showMainWindow();send("auth:status",{type:"error",message:"Сначала войдите в Fog Companion через Steam."});return;}
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
    let authenticated=false;
    try{authenticated=await syncWindow.webContents.executeJavaScript("(()=>{try{return Boolean(JSON.parse(localStorage.getItem('auth-store')||'{}')?.state?.authToken?.token)}catch{return false}})()") }catch{}
    if(authenticated&&!store.meta?.behaviourAuthenticated){store.meta={...(store.meta||{}),behaviourAuthenticated:true};writeStore(store);send("sync:status",{type:"silent",message:"",data:store})}
    if(current.includes("/match-history")){
      if(!silent)send("sync:status",{type:"info",message:"Загружаю матчи, изображения и статистику персонажей…"});
      runPageFallback();
      return;
    }
    if(current.includes("/statistics")){
      runAggregateImport();
      return;
    }
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
  if(!store?.account)return false;
  if(!store.meta?.behaviourAuthenticated)return false;
  if(store.meta?.source!=="official-stats"||statsWindow)return false;
  if(!force&&Date.now()-lastAutoSyncAttempt<45000)return false;
  lastAutoSyncAttempt=Date.now();openStatsSync(true);return true;
}

async function logoutStatsAccount(){
  if(statsWindow&&!statsWindow.isDestroyed())statsWindow.destroy();
  statsWindow=null;
  await session.fromPartition("persist:bhvr-stats").clearStorageData().catch(error=>logDiagnostic("warn","behaviour-session-clear-failed",error));
  store.meta={...(store.meta||{}),behaviourAuthenticated:false};
  writeStore(store);
  send("sync:status",{type:"info",message:"Вы вышли из Behaviour Account. Локальная история сохранена.",data:store});
  return store;
}

function gameRunning() {
  return new Promise(resolve=>execFile("powershell.exe",["-NoProfile","-Command","if(Get-Process -ErrorAction SilentlyContinue | Where-Object {$_.ProcessName -match 'DeadByDaylight'}){'yes'}else{'no'}"],{windowsHide:true},(_e,out)=>resolve(out.trim()==="yes")));
}
async function waitForGame(timeoutMs=180000) { const end=Date.now()+timeoutMs; while(Date.now()<end){if(await gameRunning())return true;await sleep(3000);}return false; }
function runHelper(points){return new Promise((resolve,reject)=>{
  const startedAt=Date.now(),scriptPath=ensureInputHelper();logDiagnostic("info","selection-helper-started",{scriptPath});
  const args=["-NoLogo","-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",scriptPath,"-SearchX",String(points.search.x),"-SearchY",String(points.search.y),"-ResultX",String(points.result.x),"-ResultY",String(points.result.y)];
  if(points.target)args.push("-TargetX",String(points.target.x),"-TargetY",String(points.target.y));
  const child=spawn("powershell.exe",args,{windowsHide:true,stdio:["ignore","pipe","pipe"]}),stdout=[],stderr=[];let settled=false;
  child.stdout.on("data",chunk=>stdout.push(Buffer.from(chunk)));child.stderr.on("data",chunk=>stderr.push(Buffer.from(chunk)));
  child.on("error",error=>{if(settled)return;settled=true;writeCrashReport("selection-helper-spawn-error",error,{scriptPath});reject(error)});
  child.on("exit",code=>{if(settled)return;settled=true;const out=decodePowerShellOutput(stdout),err=decodePowerShellOutput(stderr);logDiagnostic(code===0?"info":"error","selection-helper-exit",{code,durationMs:Date.now()-startedAt,stdout:out,stderr:err,scriptPath});code===0?resolve():reject(new Error(err||out||`PowerShell завершился с кодом ${code}`))});
});}
function runPerkHelper(perks,slotPoints,search,result){return new Promise((resolve,reject)=>{
  const startedAt=Date.now(),scriptPath=ensureInputHelper(),namesBase64=Buffer.from(JSON.stringify(perks.map(perk=>perk.name)),"utf8").toString("base64"),args=["-NoLogo","-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",scriptPath,"-SearchX",String(search.x),"-SearchY",String(search.y),"-ResultX",String(result.x),"-ResultY",String(result.y),"-NamesBase64",namesBase64];
  slotPoints.forEach((point,index)=>args.push(`-Slot${index+1}X`,String(point.x),`-Slot${index+1}Y`,String(point.y)));
  logDiagnostic("info","perk-selection-helper-started",{scriptPath,perks:perks.map(perk=>perk.name)});
  const child=spawn("powershell.exe",args,{windowsHide:true,stdio:["ignore","pipe","pipe"]}),stdout=[],stderr=[];let settled=false;
  child.stdout.on("data",chunk=>stdout.push(Buffer.from(chunk)));child.stderr.on("data",chunk=>stderr.push(Buffer.from(chunk)));
  child.on("error",error=>{if(settled)return;settled=true;writeCrashReport("perk-selection-helper-spawn-error",error,{scriptPath});reject(error)});
  child.on("exit",code=>{if(settled)return;settled=true;const out=decodePowerShellOutput(stdout),err=decodePowerShellOutput(stderr);logDiagnostic(code===0?"info":"error","perk-selection-helper-exit",{code,durationMs:Date.now()-startedAt,stdout:out,stderr:err});code===0?resolve():reject(new Error(err||out||`PowerShell завершился с кодом ${code}`))});
});}

app.whenReady().then(()=>{
  if(updateWorkerRequest){
    runUpdateWorker(updateWorkerRequest).then(()=>app.exit(0)).catch(error=>{
      writeCrashReport("update-worker-failed",error,updateWorkerRequest);
      const fallback=String(updateWorkerRequest.destination||"");
      if(fallback&&fs.existsSync(fallback))try{const child=spawn(fallback,[],{detached:true,stdio:"ignore",windowsHide:true});child.unref()}catch{}
      app.exit(1);
    });
    return;
  }
  app.setAppUserModelId("local.fogcompanion.desktop");
  setTimeout(()=>{try{fs.rmSync(path.join(app.getPath("temp"),"fog-companion-update"),{recursive:true,force:true})}catch{}},7000);
  try{ensureInputHelper()}catch(error){logDiagnostic("error","selection-helper-prepare-failed",{error:diagnosticValue(error)})}
  store=loadStore();
  if(applyAuthenticatedIdentity(store))writeStore(store);
  createMainWindow();createOverlayWindow();createTray();
  setTimeout(()=>refreshStoredProfileAvatar(),900);
  if(process.argv.includes("--sync-once")){setTimeout(()=>openStatsSync(true),1000);setTimeout(()=>app.exit(2),45000);}
  globalShortcut.register("Shift+F2",()=>toggleOverlay());
  ipcMain.handle("data:get",()=>{if(applyAuthenticatedIdentity(store))writeStore(store);return store;});
  ipcMain.handle("data:save-settings",(_e,settings)=>{store.settings={...store.settings,...settings};writeStore(store);return store;});
  ipcMain.handle("randomizer:save",(_e,value)=>{store.randomizer={...store.randomizer,...(value||{})};writeStore(store);sendRandomizerState();return store;});
  ipcMain.handle("data:delete-match",(_e,id)=>{store.matches=store.matches.filter(m=>m.id!==id);writeStore(store);return store;});
  ipcMain.handle("auth:steam-login",()=>loginWithSteam());
  ipcMain.handle("auth:logout",()=>logoutAccount());
  ipcMain.handle("stats:open-sync",()=>{if(!store.account)throw new Error("Сначала войдите через Steam.");openStatsSync();return true;});
  ipcMain.handle("stats:logout",()=>logoutStatsAccount());
  ipcMain.handle("perks:get-catalog",async()=>({items:await getKillerPerkCatalog(),data:store}));
  ipcMain.handle("perk:get-details",async(_event,perk,kind)=>{
    try{return await getPerkDetails(perk,kind)}
    catch(error){logDiagnostic("error","item-details-load-failed",{id:perk?.id||"",name:perk?.name||"",kind,error:diagnosticValue(error)});throw error}
  });
  ipcMain.handle("shell:open-external",async(_event,url)=>{
    const target=String(url||"");
    if(!/^https:\/\//i.test(target))return false;
    if(/^https:\/\/steamcommunity\.com\/(?:id|profiles)\//i.test(target)){
      try{await shell.openExternal(`steam://openurl/${target}`);return true}
      catch(error){logDiagnostic("warn","steam-client-profile-open-failed",{target,error:diagnosticValue(error)})}
    }
    await shell.openExternal(target);return true;
  });
  ipcMain.handle("game:status",()=>gameRunning());
  ipcMain.handle("update:get-status",()=>updateState);
  ipcMain.handle("update:check",()=>checkForUpdates(true));
  ipcMain.handle("update:install",()=>installAvailableUpdate());
  ipcMain.handle("diagnostics:open",()=>openDiagnosticsFolder());
  ipcMain.handle("calibration:capture",async(_e,kind)=>{mainWindow.hide();await sleep(3500);const point=screen.getCursorScreenPoint();mainWindow.show();mainWindow.maximize();mainWindow.focus();return{kind,point};});
  ipcMain.handle("game:select",async(_e,payload)=>{
    if(!store.account)throw new Error("Сначала войдите в Fog Companion через Steam.");
    if(!store.settings?.automationEnabled)throw new Error("Включите автоматический выбор в настройках Companion.");
    const {killer,searchPoint,resultPoint}=payload||{};
    logDiagnostic("info","killer-selection-requested",{killer:killer?.name||"",gameRunning:"checking"});
    if(!killer||!searchPoint||!resultPoint)throw new Error("Сначала откалибруйте поле поиска и первую карточку результата.");
    let running=await gameRunning();
    if(!running){send("game:selection-status",{type:"info",message:"Запускаю Dead by Daylight через Steam…"});await shell.openExternal("steam://rungameid/381210");running=await waitForGame();if(!running)throw new Error("Игра не запустилась за 3 минуты.");send("game:selection-status",{type:"info",message:"Игра запущена. Жду загрузку лобби…"});await sleep(35000);}
    const oldClipboard=clipboard.readText();clipboard.writeText(killer.search||killer.name);if(overlayWindow&&!overlayWindow.isDestroyed())overlayWindow.hide();await sleep(25);
    try{await runHelper({search:searchPoint,result:resultPoint});logDiagnostic("info","killer-selection-complete",{killer:killer.name});return true;}
    catch(error){const report=writeCrashReport("killer-selection-failed",error,{killer:killer.name});const visibleError=new Error("Автовыбор не сработал. Отчёт сохранён — откройте Настройки → Диагностика → Открыть папку с логами.");visibleError.report=report;throw visibleError;}
    finally{clipboard.writeText(oldClipboard);}
  });
  ipcMain.handle("game:select-perks",async(_e,payload)=>{
    if(!store.account)throw new Error("Сначала войдите в Fog Companion через Steam.");
    if(!store.settings?.automationEnabled)throw new Error("Включите автоматический выбор в настройках Companion.");
    const {perks,slotPoints,searchPoint,resultPoint}=payload||{},selected=(perks||[]).filter(perk=>perk?.name);
    if(selected.length!==4||!Array.isArray(slotPoints)||slotPoints.length!==4||slotPoints.some(point=>!point)||!searchPoint||!resultPoint)throw new Error("Сначала выберите четыре перка и откалибруйте шесть точек автовыбора.");
    if(!await gameRunning())throw new Error("Dead by Daylight не запущен. Откройте игру и экран перков.");
    const oldClipboard=clipboard.readText();
    if(overlayWindow&&!overlayWindow.isDestroyed())overlayWindow.hide();
    try{
      await runPerkHelper(selected,slotPoints,searchPoint,resultPoint);
      logDiagnostic("info","perk-selection-complete",{perks:selected.map(perk=>perk.name)});
      return true;
    }catch(error){
      const report=writeCrashReport("perk-selection-failed",error,{perks:selected.map(perk=>perk.name)});
      const visibleError=new Error("Автовыбор перков не сработал. Отчёт сохранён в папке диагностики.");visibleError.report=report;throw visibleError;
    }finally{clipboard.writeText(oldClipboard);}
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
app.on("before-quit",()=>{app.isQuitting=true;if(!updateWorkerRequest)finishDiagnosticSession("before-quit")});
app.on("activate",showMainWindow);
app.on("will-quit",()=>{globalShortcut.unregisterAll();if(tray){tray.destroy();tray=null;}});
