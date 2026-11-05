(function(root){
 'use strict';
 // A local ink mask: remove pale paper/shadows, retain dark and coloured strokes.
 // Alpha is multiplied so previously transparent PNGs stay transparent.
 function removeBackground(pixels,width,height,threshold=205){
  let left=width,top=height,right=-1,bottom=-1,ink=0;
  const out=new Uint8ClampedArray(pixels.length);
  for(let i=0;i<pixels.length;i+=4){
   const light=Math.min(pixels[i],pixels[i+1],pixels[i+2]);
   const alpha=Math.round(pixels[i+3]*Math.max(0,Math.min(1,(threshold-light)/45)));
   out[i]=pixels[i];out[i+1]=pixels[i+1];out[i+2]=pixels[i+2];out[i+3]=alpha;
   if(alpha>24){const x=(i/4)%width,y=Math.floor(i/4/width);left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);ink++;}
  }
  if(ink<8)throw Error('ไม่พบเส้นลายเซ็น กรุณาใช้ภาพที่เห็นเส้นชัด หรือปรับความไว');
  return {pixels:out,left:Math.max(0,left-12),top:Math.max(0,top-12),right:Math.min(width-1,right+12),bottom:Math.min(height-1,bottom+12)};
 }
 function mount(container,{endpoint='/api/signatures',label='ลายเซ็นของฉัน',onSaved=null}={}){
  container.innerHTML=`<h4></h4><p class="muted">อัปโหลดภาพลายเซ็นบนกระดาษสีขาว ระบบตัดพื้นหลังและเก็บเป็น PNG พื้นใส ใช้ซ้ำในงานต่าง ๆ ได้ ตรวจตัวอย่างก่อนบันทึก</p><input class="signature-file" type="file" accept="image/png,image/jpeg,image/webp"><label>ความไวในการตัดพื้นหลัง <input class="signature-threshold" type="range" min="140" max="245" value="205"></label><div style="background:repeating-conic-gradient(#e8edf2 0% 25%,#fff 0% 50%) 0/20px 20px;border:1px solid #ccd5df;border-radius:10px;padding:12px;min-height:90px"><img class="signature-preview" alt="ตัวอย่างลายเซ็นพื้นใส" style="max-width:100%;height:85px;object-fit:contain" hidden></div><p class="signature-message muted" role="status"></p><button class="btn btn-primary signature-save" type="button" disabled>บันทึกลายเซ็นพื้นใส</button>`;
  container.querySelector('h4').textContent=label;
  const q=s=>container.querySelector(s),message=q('.signature-message'),preview=q('.signature-preview'),save=q('.signature-save');
  let source=null,processed=null,version=0;
  function render(){
   processed=null;save.disabled=true;
   try{
    const canvas=document.createElement('canvas');canvas.width=source.width;canvas.height=source.height;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(source,0,0);
    const image=ctx.getImageData(0,0,canvas.width,canvas.height),mask=removeBackground(image.data,canvas.width,canvas.height,Number(q('.signature-threshold').value));
    image.data.set(mask.pixels);ctx.putImageData(image,0,0);
    const cropped=document.createElement('canvas');cropped.width=mask.right-mask.left+1;cropped.height=mask.bottom-mask.top+1;
    cropped.getContext('2d').drawImage(canvas,mask.left,mask.top,cropped.width,cropped.height,0,0,cropped.width,cropped.height);
    // ย่อจนไฟล์ไม่เกิน 60 KB (ต้องต่ำกว่าเพดานฐานข้อมูล 100 KB ต่อคำสั่ง ไม่งั้นอนุมัติเอกสารไม่ได้)
    processed=null;
    for(let max=900;max>=150;max-=75){
     const k=Math.min(1,max/cropped.width,(max*0.45)/cropped.height),out=document.createElement('canvas');
     out.width=Math.max(1,Math.round(cropped.width*k));out.height=Math.max(1,Math.round(cropped.height*k));
     out.getContext('2d').drawImage(cropped,0,0,out.width,out.height);
     const url=out.toDataURL('image/png');if(url.length<=60*1024){processed=url;break;}
    }
    if(!processed)throw Error('ภาพลายเซ็นมีรายละเอียดมากเกินไป กรุณาครอบเฉพาะลายเซ็นก่อนอัปโหลด');
    preview.src=processed;preview.hidden=false;save.disabled=false;message.textContent='ตรวจเส้นลายเซ็นและพื้นใสก่อนกดบันทึก';
   }catch(e){preview.hidden=true;message.textContent=e.message;processed=null;}
  }
  q('.signature-threshold').oninput=()=>{if(source)render();};
  q('.signature-file').onchange=async()=>{
   const current=++version,file=q('.signature-file').files[0];source=null;processed=null;save.disabled=true;
   if(!file)return;
   if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>5*1024*1024){message.textContent='ใช้ภาพ PNG, JPG หรือ WebP ขนาดไม่เกิน 5 MB';return;}
   let bitmap;
   try{
    bitmap=await createImageBitmap(file);
    if(current!==version)return;
    if(bitmap.width*bitmap.height>30000000)throw Error('ความละเอียดภาพสูงเกินไป กรุณาย่อภาพก่อน');
    const scale=Math.min(1,1600/bitmap.width,1000/bitmap.height),canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);source=canvas;render();
   }catch(e){message.textContent=e.message||'อ่านภาพไม่ได้';}finally{bitmap?.close();}
  };
  save.onclick=async()=>{
   if(!processed)return;save.disabled=true;
   try{await apiRequest(endpoint,{method:'PUT',body:{data_url:processed}});message.textContent=/user_id=/.test(endpoint)?'บันทึกและล็อคลายเซ็นพื้นใสแล้ว ใช้กับใบลา ป่าเด็งโมเดล นิเทศ ได้ทันที':'บันทึกลายเซ็นพื้นใสแล้ว พร้อมใช้ในงานต่าง ๆ';if(typeof onSaved==='function')onSaved();}
   catch(e){message.textContent=e.message;save.disabled=false;}
  };
  apiRequest(endpoint).then(data=>{if(version===0&&data.signature){preview.src=data.signature.data_url;preview.hidden=false;message.textContent='มีลายเซ็นที่บันทึกไว้แล้ว อัปโหลดใหม่เพื่อเปลี่ยนสำหรับเอกสารครั้งต่อไป';}if(version===0&&data.signature?.locked){if(/user_id=/.test(endpoint))message.textContent='🔒 ลายเซ็นล็อคแล้ว ใช้กับเอกสารทุกฉบับ (อัปโหลดใหม่เพื่อเปลี่ยน)';else{q('.signature-file').disabled=true;q('.signature-threshold').disabled=true;save.hidden=true;message.textContent='🔒 ลายเซ็นถูกล็อคโดยผู้ดูแลระบบ หากต้องการเปลี่ยนกรุณาแจ้ง Superadmin';}}}).catch(e=>{message.textContent=e.message;});
 }
 root.SignatureUpload={removeBackground,mount};
})(typeof window==='undefined'?globalThis:window);
