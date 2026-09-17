(function(){

const API='/api/admin/crm';

const state={
 selected:[],
 currentType:null,
 currentId:null
};

function toast(message,type='success'){
 let box=document.getElementById('aurelius-toast');

 if(!box){
   box=document.createElement('div');
   box.id='aurelius-toast';
   box.style.cssText=
     'position:fixed;right:24px;bottom:24px;z-index:99999;' +
     'background:#172033;color:#fff;padding:15px 18px;border-radius:12px;' +
     'box-shadow:0 15px 50px #0004;font-weight:700;max-width:380px;';
   document.body.appendChild(box);
 }

 box.textContent=message;
 box.style.background=type==='error'?'#b9151b':'#172033';

 clearTimeout(box._timer);
 box._timer=setTimeout(()=>box.remove(),3500);
}

async function api(url,options={}){
 const r=await fetch(url,{
   credentials:'include',
   headers:{
     'Content-Type':'application/json',
     ...(options.headers||{})
   },
   ...options
 });

 let data=null;
 try{data=await r.json()}catch{}

 if(!r.ok){
   throw new Error(data?.error || data?.message || `Request failed (${r.status})`);
 }

 return data;
}

function openDrawer(title,html){
 let drawer=document.getElementById('aurelius-drawer');

 if(!drawer){
   drawer=document.createElement('div');
   drawer.id='aurelius-drawer';

   drawer.innerHTML=`
   <div class="acd-overlay"></div>
   <aside class="acd-panel">
     <div class="acd-head">
       <strong id="acd-title"></strong>
       <button id="acd-close">×</button>
     </div>
     <div id="acd-body"></div>
   </aside>`;

   document.body.appendChild(drawer);

   drawer.querySelector('.acd-overlay').onclick=closeDrawer;
   drawer.querySelector('#acd-close').onclick=closeDrawer;
 }

 drawer.querySelector('#acd-title').textContent=title;
 drawer.querySelector('#acd-body').innerHTML=html;
 drawer.classList.add('open');
}

function closeDrawer(){
 document.getElementById('aurelius-drawer')?.classList.remove('open');
}

function injectStyles(){
 const style=document.createElement('style');

 style.textContent=`
 .acd-panel{
   position:fixed;
   right:0;
   top:0;
   height:100vh;
   width:min(650px,96vw);
   background:#fff;
   z-index:99991;
   box-shadow:-20px 0 80px #0003;
   transform:translateX(100%);
   transition:.25s;
   display:flex;
   flex-direction:column;
 }
 #aurelius-drawer.open .acd-panel{transform:translateX(0)}
 .acd-overlay{
   position:fixed;
   inset:0;
   background:#0007;
   z-index:99990;
   opacity:0;
   pointer-events:none;
   transition:.25s;
 }
 #aurelius-drawer.open .acd-overlay{
   opacity:1;
   pointer-events:auto;
 }
 .acd-head{
   height:70px;
   padding:0 22px;
   border-bottom:1px solid #e6e9ee;
   display:flex;
   justify-content:space-between;
   align-items:center;
   font-size:18px;
 }
 .acd-head button{
   border:0;
   background:#f1f3f6;
   border-radius:50%;
   width:36px;
   height:36px;
   font-size:22px;
   cursor:pointer;
 }
 #acd-body{
   padding:25px;
   overflow:auto;
   flex:1;
 }
 .acd-grid{
   display:grid;
   grid-template-columns:1fr 1fr;
   gap:12px;
 }
 .acd-grid .full{grid-column:1/-1}
 .acd-field label{
   display:block;
   font-size:12px;
   font-weight:800;
   margin-bottom:5px;
 }
 .acd-field input,.acd-field textarea,.acd-field select{
   width:100%;
   border:1px solid #d8dde5;
   border-radius:8px;
   padding:11px;
   font:inherit;
 }
 .acd-actions{
   display:flex;
   flex-wrap:wrap;
   gap:8px;
   margin-top:20px;
 }
 .acd-btn{
   border:0;
   border-radius:8px;
   padding:11px 15px;
   cursor:pointer;
   font-weight:800;
 }
 .acd-primary{background:#d71920;color:#fff}
 .acd-dark{background:#172033;color:#fff}
 .acd-light{background:#eef1f5;color:#172033}
 .acd-danger{background:#b9151b;color:#fff}
 .acd-command{
   position:fixed;
   inset:0;
   z-index:100000;
   display:none;
   align-items:flex-start;
   justify-content:center;
   padding-top:12vh;
   background:#0008;
 }
 .acd-command.open{display:flex}
 .acd-command-box{
   width:min(700px,94vw);
   background:#fff;
   border-radius:18px;
   overflow:hidden;
   box-shadow:0 30px 100px #0005;
 }
 .acd-command-box input{
   width:100%;
   border:0;
   border-bottom:1px solid #e6e9ee;
   padding:20px;
   font-size:18px;
   outline:none;
 }
 .acd-command-results{
   max-height:55vh;
   overflow:auto;
 }
 .acd-command-item{
   padding:16px 20px;
   cursor:pointer;
   border-bottom:1px solid #f0f2f5;
 }
 .acd-command-item:hover{background:#f6f8fb}
 .acd-ai{
   background:linear-gradient(135deg,#101827,#25334c);
   color:#fff;
   border-radius:16px;
   padding:20px;
   margin-bottom:20px;
 }
 .acd-ai textarea{
   width:100%;
   min-height:100px;
   margin-top:12px;
   padding:12px;
   border-radius:9px;
   border:1px solid #46536a;
   background:#172033;
   color:#fff;
 }
 .acd-result{
   margin-top:12px;
   padding:14px;
   border-radius:10px;
   background:#f4f6f8;
   color:#172033;
   white-space:pre-wrap;
 }
 @media(max-width:600px){
   .acd-grid{grid-template-columns:1fr}
   .acd-grid .full{grid-column:auto}
 }
 `;

 document.head.appendChild(style);
}

function commandPalette(){

 const wrap=document.createElement('div');
 wrap.className='acd-command';
 wrap.id='acd-command';

 wrap.innerHTML=`
 <div class="acd-command-box">
   <input id="acd-command-input" placeholder="Search CRM, open a section, create a client..." autocomplete="off">
   <div class="acd-command-results" id="acd-command-results"></div>
 </div>`;

 document.body.appendChild(wrap);

 wrap.onclick=e=>{
   if(e.target===wrap) wrap.classList.remove('open');
 };

 const commands=[
   ['Dashboard',()=>clickNav('Dashboard')],
   ['Enquiries',()=>clickNav('Enquiries')],
   ['Clients',()=>clickNav('Clients')],
   ['Premises',()=>clickNav('Premises')],
   ['Quotes',()=>clickNav('Quotes')],
   ['Bookings',()=>clickNav('Bookings')],
   ['Documents',()=>clickNav('Documents')],
   ['Actions',()=>clickNav('Actions')],
   ['Messages',()=>clickNav('Messages')],
   ['Website Editor',()=>clickNav('Website Editor')],
   ['Pricing',()=>clickNav('Pricing')],
   ['About Me',()=>clickNav('About Me')],
   ['Availability',()=>clickNav('Availability')],
   ['Terms & Policies',()=>clickNav('Terms & Policies')],
   ['Users',()=>clickNav('Users')],
   ['Settings',()=>clickNav('Settings')],
   ['AI Assistant',openAI]
 ];

 function render(filter=''){
   const list=document.getElementById('acd-command-results');

   const filtered=commands.filter(x=>x[0].toLowerCase().includes(filter.toLowerCase()));

   list.innerHTML=filtered.map((x,i)=>
     `<div class="acd-command-item" data-i="${i}">${x[0]}</div>`
   ).join('');

   list.querySelectorAll('.acd-command-item').forEach(item=>{
     item.onclick=()=>{
       commands[Number(item.dataset.i)][1]();
       wrap.classList.remove('open');
     };
   });
 }

 render();

 document.getElementById('acd-command-input').addEventListener('input',e=>render(e.target.value));

 window.openAureliusCommand=()=>{
   wrap.classList.add('open');
   const input=document.getElementById('acd-command-input');
   input.value='';
   input.focus();
   render();
 };
}

function clickNav(name){
 const items=[...document.querySelectorAll('button,a')];
 const el=items.find(x=>x.textContent.trim().toLowerCase()===name.toLowerCase());
 if(el) el.click();
 else toast(`Could not locate ${name} in the current CRM`, 'error');
}

async function globalSearch(query){

 try{

   const result=await api(`${API}/search?q=${encodeURIComponent(query)}`);

   openDrawer('Global CRM Search',`
     <div style="margin-bottom:15px;color:#667085">
       Search results for <strong>${escapeHtml(query)}</strong>
     </div>
     <div>
       ${renderSearchResults(result)}
     </div>
   `);

 }catch(e){
   toast(e.message,'error');
 }
}

function renderSearchResults(data){

 const items=Array.isArray(data)?data:
   data?.results ||
   data?.items ||
   data?.data ||
   [];

 if(!items.length){
   return '<p>No matching CRM records found.</p>';
 }

 return items.map(item=>`
   <div style="padding:15px;border:1px solid #e6e9ee;border-radius:10px;margin-bottom:8px">
     <strong>${escapeHtml(item.name||item.title||item.companyName||item.email||'CRM record')}</strong>
     <div style="font-size:12px;color:#667085;margin-top:4px">
       ${escapeHtml(item.type||item.entityType||'')}
     </div>
     <pre style="white-space:pre-wrap;font-size:11px">${escapeHtml(JSON.stringify(item,null,2))}</pre>
   </div>
 `).join('');
}

function escapeHtml(v){
 return String(v??'')
   .replaceAll('&','&amp;')
   .replaceAll('<','&lt;')
   .replaceAll('>','&gt;')
   .replaceAll('"','&quot;');
}

function openAI(context=''){
 openDrawer('Aurelius AI Assistant',`
   <div class="acd-ai">
     <strong style="font-size:18px">Aurelius AI</strong>
     <p style="color:#cbd3df">
       Ask the AI to analyse a client, improve wording, draft a response,
       summarise an enquiry, create website copy or suggest next actions.
     </p>

     <textarea id="acd-ai-input" placeholder="What would you like Aurelius AI to do?"></textarea>

     <div class="acd-actions">
       <button class="acd-btn acd-primary" id="acd-ai-run">Ask AI</button>
       <button class="acd-btn acd-light" id="acd-ai-summary">Summarise current page</button>
       <button class="acd-btn acd-light" id="acd-ai-copy">Improve this wording</button>
     </div>
   </div>

   <div id="acd-ai-result"></div>
 `);

 const input=document.getElementById('acd-ai-input');
 const result=document.getElementById('acd-ai-result');

 if(context) input.value=context;

 async function run(prompt){

   result.innerHTML='<div class="acd-result">AI is thinking...</div>';

   try{

     const r=await fetch('/api/ai/assist',{
       method:'POST',
       credentials:'include',
       headers:{'Content-Type':'application/json'},
       body:JSON.stringify({
         prompt,
         page:location.pathname,
         context:document.body.innerText.slice(0,12000)
       })
     });

     const data=await r.json();

     if(!r.ok) throw new Error(data.error||'AI request failed');

     result.innerHTML=
       `<div class="acd-result">${escapeHtml(data.output||data.text||'No response')}</div>`;

   }catch(e){
     result.innerHTML=
       `<div class="acd-result">AI unavailable: ${escapeHtml(e.message)}</div>`;
   }
 }

 document.getElementById('acd-ai-run').onclick=()=>{
   const p=input.value.trim();
   if(p) run(p);
 };

 document.getElementById('acd-ai-summary').onclick=()=>{
   run('Summarise the current CRM page into concise operational points and identify the most useful next actions.');
 };

 document.getElementById('acd-ai-copy').onclick=()=>{
   run('Improve the customer-facing wording visible on this page. Keep it professional, concise, UK English and suitable for a fire risk assessment business.');
 };
}

function addTopTools(){

 const bar=document.createElement('div');

 bar.style.cssText=
   'position:fixed;right:20px;bottom:20px;z-index:90000;display:flex;gap:8px;';

 bar.innerHTML=`
   <button id="acd-search-btn" title="Search CRM"
     style="border:0;border-radius:12px;padding:12px 15px;background:#172033;color:#fff;font-weight:800;cursor:pointer">
     🔎 Search
   </button>

   <button id="acd-ai-btn" title="Aurelius AI"
     style="border:0;border-radius:12px;padding:12px 15px;background:#d71920;color:#fff;font-weight:800;cursor:pointer">
     ✦ AI
   </button>
 `;

 document.body.appendChild(bar);

 document.getElementById('acd-ai-btn').onclick=()=>openAI();

 document.getElementById('acd-search-btn').onclick=()=>{

   openDrawer('Global CRM Search',`
     <div class="acd-field">
       <label>Search everything</label>
       <input id="acd-global-search" placeholder="Client, company, email, premises, quote..." autofocus>
     </div>
     <div class="acd-actions">
       <button class="acd-btn acd-primary" id="acd-run-search">Search CRM</button>
     </div>
     <div id="acd-search-results"></div>
   `);

   document.getElementById('acd-run-search').onclick=()=>{
     const q=document.getElementById('acd-global-search').value.trim();
     if(q) globalSearch(q);
   };
 };
}

function keyboard(){

 document.addEventListener('keydown',e=>{

   if((e.metaKey||e.ctrlKey) && e.key.toLowerCase()==='k'){
     e.preventDefault();
     window.openAureliusCommand?.();
   }

   if(e.key==='Escape'){
     document.querySelector('.acd-command.open')?.classList.remove('open');
     document.getElementById('aurelius-drawer')?.classList.remove('open');
   }
 });
}

function addQuickActions(){

 const possible=document.querySelector('main')||document.body;

 const panel=document.createElement('div');

 panel.style.cssText=
   'margin:15px;padding:14px;border:1px solid #e6e9ee;border-radius:14px;background:#fff;';

 panel.innerHTML=`
 <strong>Quick Actions</strong>
 <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">
   <button class="acd-btn acd-dark" data-q="Enquiries">+ Enquiry</button>
   <button class="acd-btn acd-dark" data-q="Clients">+ Client</button>
   <button class="acd-btn acd-dark" data-q="Premises">+ Premises</button>
   <button class="acd-btn acd-dark" data-q="Quotes">+ Quote</button>
   <button class="acd-btn acd-dark" data-q="Bookings">+ Booking</button>
   <button class="acd-btn acd-light" data-q="Website Editor">Edit Website</button>
   <button class="acd-btn acd-light" data-q="Pricing">Edit Pricing</button>
   <button class="acd-btn acd-primary" id="quick-ai">Ask AI</button>
 </div>
 `;

 possible.prepend(panel);

 panel.querySelectorAll('[data-q]').forEach(btn=>{
   btn.onclick=()=>clickNav(btn.dataset.q);
 });

 panel.querySelector('#quick-ai').onclick=()=>openAI();
}

function init(){

 injectStyles();
 commandPalette();
 addTopTools();
 keyboard();

 // Add Ctrl/Cmd + K hint to document title
 document.title='Aurelius Fire CRM';

 setTimeout(()=>{
   try{addQuickActions()}catch{}
 },1000);

}

if(document.readyState==='loading'){
 document.addEventListener('DOMContentLoaded',init);
}else{
 init();
}

window.AureliusCommandCentre={
 toast,
 openAI,
 globalSearch,
 openDrawer,
 closeDrawer
};

})();
