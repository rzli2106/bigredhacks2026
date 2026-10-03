import { readFile } from 'node:fs/promises';
export async function loadEnvironment() {
  try {
    const content=await readFile(new URL('../.env',import.meta.url),'utf8');
    for(const line of content.split(/\r?\n/)){
      const match=line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if(!match||process.env[match[1]]!==undefined)continue;
      const value=match[2];process.env[match[1]]=/^(["']).*\1$/.test(value)?value.slice(1,-1):value.replace(/\s+#.*$/,'');
    }
  } catch(error){if(error.code!=='ENOENT')throw error;}
}
