// Bounded raster container validation. Browser load events independently prove rendering.
// SVG, animation, tiny/default-like thumbnails, oversized dimensions and metadata are rejected/removed.
const join=parts=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let i=0;for(const p of parts){out.set(p,i);i+=p.length;}return out;};
const label=b=>String.fromCharCode(...b);
const dimensions=(w,h)=>Number.isInteger(w)&&Number.isInteger(h)&&w>=32&&h>=32&&w<=2048&&h<=2048&&w*h<=4_000_000;
export function cleanRaster(bytes) {
  if(!(bytes instanceof Uint8Array)||bytes.length<32||bytes.length>200000)return null;
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  try {
    if([137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v)) {
      const parts=[bytes.slice(0,8)];let offset=8,header=false,data=false,end=false;
      while(offset+12<=bytes.length){const length=view.getUint32(offset),type=label(bytes.slice(offset+4,offset+8));
        if(offset+length+12>bytes.length||length>200000)return null;
        if(!header&&type!=='IHDR')return null;
        if(type==='IHDR'){if(header||length!==13||!dimensions(view.getUint32(offset+8),view.getUint32(offset+12)))return null;header=true;}
        if(['acTL','fcTL','fdAT'].includes(type))return null;
        if(type==='IDAT')data=true;
        if(['IHDR','PLTE','tRNS','IDAT','IEND'].includes(type))parts.push(bytes.slice(offset,offset+length+12));
        offset+=length+12;if(type==='IEND'){end=length===0&&offset===bytes.length;break;}
      }
      return header&&data&&end?{bytes:join(parts),mime:'image/png'}:null;
    }
    if(bytes[0]===255&&bytes[1]===216){let offset=2,valid=false;const parts=[bytes.slice(0,2)];
      while(offset+4<=bytes.length){if(bytes[offset]!==255)return null;const marker=bytes[offset+1],length=view.getUint16(offset+2);
        if(length<2||offset+2+length>bytes.length)return null;
        if([0xc0,0xc1,0xc2].includes(marker)){if(length<8||!dimensions(view.getUint16(offset+7),view.getUint16(offset+5)))return null;valid=true;}
        if(marker===0xda){if(!valid||bytes.at(-2)!==255||bytes.at(-1)!==217)return null;parts.push(bytes.slice(offset));return {bytes:join(parts),mime:'image/jpeg'};}
        if(!(marker>=0xe0&&marker<=0xef)&&marker!==0xfe)parts.push(bytes.slice(offset,offset+2+length));
        offset+=2+length;
      }
    }
    if(label(bytes.slice(0,4))==='RIFF'&&label(bytes.slice(8,12))==='WEBP'){
      if(view.getUint32(4,true)+8!==bytes.length)return null;
      const parts=[bytes.slice(0,12)];let offset=12,valid=false,pixels=false;
      const uint24=i=>bytes[i]+(bytes[i+1]<<8)+(bytes[i+2]<<16);
      while(offset+8<=bytes.length){const type=label(bytes.slice(offset,offset+4)),length=view.getUint32(offset+4,true),end=offset+8+length+(length%2);
        if(end>bytes.length)return null;
        if(['ANIM','ANMF'].includes(type))return null;
        const chunk=bytes.slice(offset,end),p=offset+8;
        if(type==='VP8X'){if(length!==10||bytes[p]&2)return null;valid=dimensions(1+uint24(p+4),1+uint24(p+7));chunk[8]&=~(32|8|4);}
        if(type==='VP8L'){if(length<5||bytes[p]!==47)return null;const bits=view.getUint32(p+1,true);valid=dimensions((bits&16383)+1,((bits>>>14)&16383)+1);pixels=true;}
        if(type==='VP8 '){if(length<10||label(bytes.slice(p+3,p+6))!=='\x9d\x01\x2a')return null;valid=dimensions(view.getUint16(p+6,true)&16383,view.getUint16(p+8,true)&16383);pixels=true;}
        if(!['EXIF','XMP ','ICCP'].includes(type))parts.push(chunk);offset=end;
      }
      if(valid&&pixels&&offset===bytes.length){const result=join(parts);new DataView(result.buffer).setUint32(4,result.length-8,true);return {bytes:result,mime:'image/webp'};}
    }
  }catch{return null;}
  return null;
}
