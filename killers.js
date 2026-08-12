window.FOG_KILLERS = [
  { id:"trapper", name:"Охотник", search:"Охотник" }, { id:"wraith", name:"Призрак", search:"Призрак" },
  { id:"hillbilly", name:"Деревенщина", search:"Деревенщина" }, { id:"nurse", name:"Медсестра", search:"Медсестра" },
  { id:"shape", name:"Тень", search:"Тень" }, { id:"hag", name:"Ведьма", search:"Ведьма" },
  { id:"doctor", name:"Доктор", search:"Доктор" }, { id:"huntress", name:"Охотница", search:"Охотница" },
  { id:"cannibal", name:"Каннибал", search:"Каннибал" }, { id:"nightmare", name:"Кошмар", search:"Кошмар" },
  { id:"pig", name:"Свинья", search:"Свинья" }, { id:"clown", name:"Клоун", search:"Клоун" },
  { id:"spirit", name:"Дух", search:"Дух" }, { id:"legion", name:"Легион", search:"Легион" },
  { id:"plague", name:"Чума", search:"Чума" }, { id:"ghostface", name:"Гоуст Фейс", search:"Гоуст Фейс" },
  { id:"demogorgon", name:"Демогоргон", search:"Демогоргон" }, { id:"oni", name:"Они", search:"Они" },
  { id:"deathslinger", name:"Стрелок", search:"Стрелок" }, { id:"executioner", name:"Палач", search:"Палач" },
  { id:"blight", name:"Мор", search:"Мор" }, { id:"twins", name:"Близнецы", search:"Близнецы" },
  { id:"trickster", name:"Трюкач", search:"Трюкач" }, { id:"nemesis", name:"Немезис", search:"Немезис" },
  { id:"cenobite", name:"Сенобит", search:"Сенобит" }, { id:"artist", name:"Художница", search:"Художница" },
  { id:"onryo", name:"Онре", search:"Онре" }, { id:"dredge", name:"Грязь", search:"Грязь" },
  { id:"mastermind", name:"Кукловод", search:"Кукловод" }, { id:"knight", name:"Рыцарь", search:"Рыцарь" },
  { id:"skullmerchant", name:"Торговка черепами", search:"Торговка черепами" }, { id:"singularity", name:"Сингулярность", search:"Сингулярность" },
  { id:"xenomorph", name:"Ксеноморф", search:"Ксеноморф" }, { id:"goodguy", name:"Хороший парень", search:"Хороший парень" },
  { id:"unknown", name:"Неведомое", search:"Неведомое" }, { id:"lich", name:"Лич", search:"Лич" },
  { id:"darklord", name:"Темный властелин", search:"Темный властелин" }, { id:"houndmaster", name:"Егерь", search:"Егерь" },
  { id:"ghoul", name:"Гуль", search:"Гуль" }, { id:"animatronic", name:"Аниматроник", search:"Аниматроник" },
  { id:"krasue", name:"Красуэ", search:"Красуэ" }, { id:"first", name:"Первый", search:"Первый" },
  { id:"slasher", name:"Слэшер", search:"Слэшер" }
];
const FOG_KILLER_CHARACTER_IDS=["Chuckles","Bob","HillBilly","Nurse","Shape","Witch","Killer07","Bear","Cannibal","Nightmare","Pig","Clown","Spirit","Legion","Plague","Ghostface","Demogorgon","Oni","Gunslinger","K20","K21","K22","K23","K24","K25","K26","K27","K28","K29","K30","K31","K32","K33","K34","K35","K36","K37","K38","K39","K40","K41","K42","K43"];
window.FOG_KILLERS.forEach((killer,index)=>{killer.image=`https://assets.live.bhvraccount.com/characters/killers/${FOG_KILLER_CHARACTER_IDS[index]}.png`});
