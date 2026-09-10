/**
 * Real share-link codec — same hashids as lib/hashids.ts (salt "routing",
 * min length 11), plus the decode side. Verified by round-tripping real
 * share links (Ohtani, Drake Maye).
 *
 * Route shapes: player booster = [2, sport, 0, playerEntityId],
 *               listing        = [30, 0, 0, listingId].
 * Routing sport ids: MLB 4 · NFL 2 · CFB 11 · WNBA 12 · FC 14.
 *
 * Usage:
 *   node scripts/share-link.mjs decode k3tvTvFwRow
 *   node scripts/share-link.mjs encode 2 4 0 660271
 */
import { pathToFileURL } from "node:url";
const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
const SEPS = "cfhistuCFHISTU";

function uniqueArr(arr){const s=new Set();const o=[];for(const x of arr){if(!s.has(x)){s.add(x);o.push(x);}}return o;}
function shuffleArr(arr,salt){if(salt.length===0)return arr.slice();const r=arr.slice();let o=r.length-1,i=0,a=0;while(o>0){i=i%salt.length;const n=salt[i].charCodeAt(0);a+=n;const c=(n+i+a)%o;[r[c],r[o]]=[r[o],r[c]];o-=1;i+=1;}return r;}
function hashNum(e,t){const n=[];while(true){n.unshift(t[e%t.length]);e=Math.floor(e/t.length);if(e<=0)break;}return n;}

class H {
  constructor(saltStr="",minLength=0){
    this.salt=[...saltStr];this.minLength=minLength;
    let alphabet=uniqueArr([...ALPHABET]);let seps=uniqueArr([...SEPS]);
    alphabet=alphabet.filter(c=>!seps.includes(c));
    seps=shuffleArr(seps,this.salt);
    if(seps.length===0||alphabet.length/seps.length>3.5){const h=Math.floor(alphabet.length/3.5);if(h>seps.length){const b=h-seps.length;seps=seps.concat(alphabet.slice(0,b));alphabet=alphabet.slice(b);}}
    this.alphabet0=shuffleArr(alphabet,this.salt);
    this.seps=seps.slice();
    const s=Math.floor(this.alphabet0.length/12);
    if(this.alphabet0.length<3){this.guards=seps.slice(0,s);this.seps=seps.slice(s);}
    else{this.guards=this.alphabet0.slice(0,s);this.alphabet=this.alphabet0.slice(s);}
  }
  encode(input){
    const numbers=Array.isArray(input)?input:[input];
    const o=numbers.reduce((acc,v,i)=>acc+(v%(i+100)),0);
    let n=this.alphabet.slice();
    let result=[n[o%n.length]];
    const a=result.slice();
    for(let l=0;l<numbers.length;l++){
      const val=numbers[l];
      n=shuffleArr(n,a.concat(this.salt,n));
      const f=hashNum(val,n);
      result=result.concat(f);
      if(l+1<numbers.length){const p=f[0].charCodeAt(0)+l;const m=val%p;result.push(this.seps[m%this.seps.length]);}
    }
    if(result.length<this.minLength){
      const u=(o+result[0].charCodeAt(0))%this.guards.length;
      result.unshift(this.guards[u]);
      if(result.length<this.minLength){const s2=(o+result[2].charCodeAt(0))%this.guards.length;result.push(this.guards[s2]);}
    }
    const f=Math.floor(n.length/2);
    while(result.length<this.minLength){
      n=shuffleArr(n,n);
      result=n.slice(f).concat(result);
      result=result.concat(n.slice(0,f));
      const h=result.length-this.minLength;
      if(h>0){const b=Math.floor(h/2);result=result.slice(b,b+this.minLength);}
    }
    return result.join("");
  }
  decode(str){
    if(!str)return [];
    let h=str;
    if(this.guards.includes(h[0]))h=h.slice(1);
    if(h.length&&this.guards.includes(h[h.length-1]))h=h.slice(0,-1);
    const sepSet=new Set(this.seps);
    const parts=[];let cur="";
    for(const ch of h){if(sepSet.has(ch)){if(cur)parts.push(cur);cur="";}else cur+=ch;}
    if(cur)parts.push(cur);
    const ret=[];
    let alphabet=this.alphabet.slice();
    let lottery=null;
    for(let i=0;i<parts.length;i++){
      const sub=parts[i];if(!sub)continue;
      if(i===0){lottery=sub[0];}
      const digits=i===0?sub.slice(1):sub;
      if(!digits){ret.push(0);continue;}
      alphabet=shuffleArr(alphabet,[lottery].concat(this.salt,alphabet));
      let num=0;
      for(const ch of digits){num=num*alphabet.length+alphabet.indexOf(ch);}
      ret.push(num);
    }
    return ret;
  }
}


const codec = () => new H("routing", 11);

function usage() {
  console.error("usage: node scripts/share-link.mjs decode <code> | encode <n> [n...]");
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "decode" && args[0]) console.log(JSON.stringify(codec().decode(args[0])));
  else if (cmd === "encode" && args.length) console.log(codec().encode(args.map(Number)));
  else if (cmd === "test") {
    for (const code of ["k3tvTvFwRow", "ngQt6tRFxNJ"]) {
      const nums = codec().decode(code);
      console.log(code, JSON.stringify(nums), codec().encode(nums) === code ? "OK" : "MISMATCH");
    }
  } else usage();
}
