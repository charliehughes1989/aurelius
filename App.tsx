import { useState, useEffect } from 'react';
import { api } from './lib/api.ts';
export default function App(){
  const [clients, setClients]=useState<any[]>([]); const [showArchived,setShowArchived]=useState(false);
  const [newClient,setNewClient]=useState({companyName:'', responsiblePerson:'', email:''});
  useEffect(()=>{ api.list('clients', showArchived?'archived':'active').then(setClients); },[showArchived]);
  return (
    <div style={{fontFamily:'system-ui', padding:20, maxWidth:900, margin:'0 auto'}}>
      <h1 style={{fontSize:32, fontWeight:800}}>🔥 Aurelius Fire - Admin Control</h1>
      <p style={{color:'#666'}}>RRFSO Article 9 | PAS 79-1:2020 | Full Control: Create, Edit, Archive/Restore, Permanent Delete</p>
      <div style={{marginTop:20, padding:16, border:'1px solid #ddd', borderRadius:12}}>
        <h3>Add New Client (Responsible Person)</h3>
        <input placeholder='Company' value={newClient.companyName} onChange={e=>setNewClient({...newClient, companyName:e.target.value})} style={{margin:4, padding:8, border:'1px solid #ccc'}}/>
        <input placeholder='Responsible Person' value={newClient.responsiblePerson} onChange={e=>setNewClient({...newClient, responsiblePerson:e.target.value})} style={{margin:4, padding:8, border:'1px solid #ccc'}}/>
        <input placeholder='Email' value={newClient.email} onChange={e=>setNewClient({...newClient, email:e.target.value})} style={{margin:4, padding:8, border:'1px solid #ccc'}}/>
        <button onClick={()=>api.create('clients', newClient).then(()=>location.reload())} style={{padding:'8px 16px', background:'black', color:'white', borderRadius:8, marginLeft:8}}>Create</button>
      </div>
      <div style={{marginTop:20}}><button onClick={()=>setShowArchived(!showArchived)} style={{padding:'8px 16px', background: showArchived?'#D4AF37':'#eee', borderRadius:8}}>{showArchived?'Show Active (Default)':'Show Archived / Deactivated'}</button></div>
      <div style={{marginTop:16}}>{clients.map(c=><div key={c.id} style={{border:'1px solid #eee', padding:12, borderRadius:8, marginBottom:8, display:'flex', justifyContent:'space-between'}}><div><b>{c.companyName}</b><br/><small>{c.responsiblePerson} | {c.status} | v{c.version}</small></div><div><button onClick={()=>{const n=prompt('Edit company name', c.companyName); if(n) api.update('clients', c.id, {companyName:n}).then(()=>location.reload())}} style={{marginRight:8}}>Edit</button><button onClick={()=>api.archive('clients', c.id).then(()=>location.reload())} style={{marginRight:8}}>Archive</button><button onClick={()=>api.restore('clients', c.id).then(()=>location.reload())} style={{marginRight:8}}>Restore / Reactivate</button><button onClick={()=>{if(confirm('PERMANENTLY DELETE? This cannot be undone.')) api.del('clients', c.id).then(()=>location.reload())}} style={{color:'red'}}>Delete</button></div></div>)}</div>
      <p style={{marginTop:40, color:'#888'}}>This same pattern works for Premises, Enquiries, Quotations, Jobs, Users, Documents, Questionnaire Sections & Questions. All have archive/restore/permanent delete + full edit + audit log.</p>
    </div>
  )
}