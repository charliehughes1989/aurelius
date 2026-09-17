import express from 'express';

const router=express.Router();

function requireAdmin(req:any,res:any,next:any){
 const user=req.user;

 if(!user){
   return res.status(401).json({error:'Authentication required'});
 }

 if(!['super_admin','admin','assessor'].includes(user.role)){
   return res.status(403).json({error:'Assessor/admin access required'});
 }

 next();
}

router.post('/assist',requireAdmin,async(req,res)=>{

 try{

   const prompt=String(req.body?.prompt||'').trim();

   if(!prompt){
     return res.status(400).json({error:'Prompt is required'});
   }

   const apiKey=process.env.OPENAI_API_KEY;

   if(!apiKey){
     return res.status(503).json({
       error:'AI is not configured. Add OPENAI_API_KEY to .env.'
     });
   }

   const model=process.env.OPENAI_MODEL || 'gpt-5.6-luna';

   const context=String(req.body?.context||'').slice(0,16000);

   const system=[
     'You are Aurelius AI, the internal AI assistant for a UK fire risk assessment business.',
     'Use UK English.',
     'Be concise, practical and professional.',
     'Do not invent legal requirements.',
     'Distinguish legal requirements from guidance.',
     'Never fabricate fire safety standards, clauses, certificates or inspection results.',
     'You assist with CRM administration, customer communications, website copy and operational workflows.',
     'Do not make a fire risk assessment itself unless the user supplies the necessary evidence and specifically asks for analysis.',
     'When drafting customer-facing material, keep it clear and professional.',
     'When reviewing CRM information, highlight missing information rather than guessing.'
   ].join('\\n');

   const response=await fetch('https://api.openai.com/v1/responses',{
     method:'POST',
     headers:{
       'Authorization':`Bearer ${apiKey}`,
       'Content-Type':'application/json'
     },
     body:JSON.stringify({
       model,
       instructions:system,
       input:`USER REQUEST:\\n${prompt}\\n\\nCURRENT CRM CONTEXT:\\n${context}`
     })
   });

   const data:any=await response.json();

   if(!response.ok){
     return res.status(response.status).json({
       error:data?.error?.message || 'OpenAI request failed'
     });
   }

   let output='';

   if(typeof data.output_text==='string'){
     output=data.output_text;
   }else if(Array.isArray(data.output)){
     output=data.output
       .flatMap((item:any)=>item.content||[])
       .map((item:any)=>item.text||'')
       .filter(Boolean)
       .join('\\n');
   }

   res.json({
     ok:true,
     model,
     output:output||'No AI response was returned.'
   });

 }catch(error:any){

   console.error('AI assistant error:',error);

   res.status(500).json({
     error:error?.message||'AI service error'
   });
 }
});

export default router;
