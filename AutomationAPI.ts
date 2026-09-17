import express from 'express';
import {
  actor,
  isAdminRole,
  dashboardSummary,
  client360,
  createEnquiryPipeline,
  advanceWorkflow,
  createOnboardingTasks,
  createBookingTasks,
  createAction,
  completeTask,
  actionSummary,
  processAutomation,
  runClientAutomation,
  WORKFLOW_STAGES
} from './AutomationEngine.ts';
import { authRequired } from './auth.ts';
import { db, getEntity, listEntities, saveEntity, now } from './database.ts';

const router = express.Router();
router.use(express.json({limit:'20mb'}));

function admin(req:any) {
  return isAdminRole(req.user?.role);
}

function requireAdmin(req:any,res:any,next:any) {
  if (!admin(req)) return res.status(403).json({error:'Administrator access required'});
  next();
}

function clientId(req:any, requested?:string) {
  if (admin(req)) return requested;
  if (!req.user?.clientId) return null;
  return req.user.clientId;
}

/*
 * Dashboard
 */
router.get('/dashboard', requireAdmin, (_req,res) => {
  res.json({
    ok:true,
    summary:dashboardSummary(),
    stages:WORKFLOW_STAGES
  });
});

/*
 * Full client 360
 */
router.get('/client/:clientId/360', (req,res) => {
  const cid = clientId(req, req.params.clientId);
  if (!cid) return res.status(403).json({error:'Client access is not configured'});
  res.json({ok:true,...client360(cid)});
});

/*
 * Create complete enquiry pipeline.
 * Public website may call the separate public endpoint in Server.ts.
 */
router.post('/enquiry', requireAdmin, (req,res) => {
  const result = createEnquiryPipeline(req.body || {}, actor(req));
  res.status(201).json({ok:true,...result});
});

/*
 * Advance workflow manually.
 */
router.post('/client/:clientId/stage', requireAdmin, (req,res) => {
  const result = advanceWorkflow(
    req.params.clientId,
    req.body?.stage,
    actor(req),
    req.body?.reason || 'Manual CRM update'
  );
  res.json({ok:true,workflow:result});
});

/*
 * Automatically process every client.
 */
router.post('/process', requireAdmin, (_req,res) => {
  res.json({ok:true,...processAutomation()});
});

/*
 * Process one client.
 */
router.post('/client/:clientId/process', requireAdmin, (req,res) => {
  res.json({
    ok:true,
    workflow:runClientAutomation(req.params.clientId, actor(req))
  });
});

/*
 * Onboarding tasks.
 */
router.get('/client/:clientId/tasks', (req,res) => {
  const cid = clientId(req,req.params.clientId);
  if (!cid) return res.status(403).json({error:'Access denied'});
  res.json({
    ok:true,
    tasks:listEntities('workflow_task',cid,'all')
  });
});

router.post('/client/:clientId/tasks/bootstrap', requireAdmin, (req,res) => {
  res.json({
    ok:true,
    tasks:createOnboardingTasks(req.params.clientId,actor(req))
  });
});

router.post('/task/:taskId/complete', (req,res) => {
  const task = getEntity('workflow_task',req.params.taskId);
  if (!task) return res.status(404).json({error:'Task not found'});

  const cid = clientId(req,task.clientId);
  if (!cid || cid !== task.clientId) return res.status(403).json({error:'Access denied'});

  res.json({
    ok:true,
    task:completeTask(req.params.taskId,actor(req),req.body?.evidence)
  });
});

/*
 * Booking preparation.
 */
router.post('/client/:clientId/booking/:bookingId/tasks', requireAdmin, (req,res) => {
  res.json({
    ok:true,
    tasks:createBookingTasks(
      req.params.clientId,
      req.params.bookingId,
      actor(req)
    )
  });
});

/*
 * Actions.
 */
router.get('/actions', requireAdmin, (req,res) => {
  res.json({
    ok:true,
    summary:actionSummary(),
    actions:listEntities('action',undefined,'all')
  });
});

router.get('/client/:clientId/actions', (req,res) => {
  const cid = clientId(req,req.params.clientId);
  if (!cid) return res.status(403).json({error:'Access denied'});
  res.json({
    ok:true,
    summary:actionSummary(cid),
    actions:listEntities('action',cid,'all')
  });
});

router.post('/client/:clientId/action', (req,res) => {
  const cid = clientId(req,req.params.clientId);
  if (!cid) return res.status(403).json({error:'Access denied'});

  const action = createAction(cid,req.body || {},actor(req));

  res.status(201).json({ok:true,action});
});

router.post('/task/:taskId/archive', requireAdmin, (req,res) => {
  const task = getEntity('workflow_task',req.params.taskId);
  if (!task) return res.status(404).json({error:'Task not found'});

  const updated = saveEntity(
    'workflow_task',
    {...task,status:'cancelled',updatedAt:now()},
    actor(req),
    'workflow_task_cancelled'
  );

  res.json({ok:true,task:updated});
});

/*
 * Workflow summary by stage.
 */
router.get('/stages', requireAdmin, (_req,res) => {
  const workflows = listEntities('workflow',undefined,'all');
  const grouped:any = {};

  for (const stage of WORKFLOW_STAGES) grouped[stage] = [];

  for (const w of workflows) {
    if (!grouped[w.stage]) grouped[w.stage] = [];
    grouped[w.stage].push(w);
  }

  res.json({ok:true,stages:grouped});
});

/*
 * Automation health.
 */
router.get('/health', requireAdmin, (_req,res) => {
  res.json({
    ok:true,
    automation:'ready',
    stages:WORKFLOW_STAGES.length,
    timestamp:now()
  });
});

export default router;
