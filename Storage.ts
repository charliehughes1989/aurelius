import fs from 'fs'; import path from 'path';
const DATA_DIR = path.join(process.cwd(), 'data');
export const readJson = <T>(file:string, fallback:T):T => { try{ return JSON.parse(fs.readFileSync(path.join(DATA_DIR,file),'utf8')); }catch{ return fallback; } }
export const writeJson = (file:string, data:any) => { fs.mkdirSync(DATA_DIR,{recursive:true}); fs.writeFileSync(path.join(DATA_DIR,file), JSON.stringify(data,null,2)); }