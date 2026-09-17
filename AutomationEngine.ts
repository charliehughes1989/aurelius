import { db, id, now, parse, saveEntity, listEntities, getEntity, writeAudit, enqueueNotification } from './database.ts';

export const WORKFLOW_STAGES = [
  'enquiry',
  'quote',
  'accepted',
  'terms',
  'onboarding',
  'payment',
  'ready_to_book',
  'booked',
  'assessment',
  'report',
  'actions',
  'complete'
] as const;

export type WorkflowStage = typeof WORKFLOW_STAGES[number];

const adminRoles = ['super_admin', 'admin', 'owner', 'assessor'];

export function isAdminRole(role: string | undefined) {
  return !!role && adminRoles.includes(role);
}

export function actor(req: any) {
  const u = req?.user || {};
  return {
    id: u.id || 'system',
    role: u.role || 'system'
  };
}

export function workflowFor(clientId: string) {
  const rows = listEntities('workflow', clientId, 'all');
  return rows[0] || {
    id: `workflow-${clientId}`,
    clientId,
    stage: 'enquiry',
    history: [],
    checklist: {},
    createdAt: now(),
    updatedAt: now(),
    persisted: false
  };
}

export function ensureWorkflow(clientId: string, reqActor?: {id:string;role:string}) {
  const rows = listEntities('workflow', clientId, 'all');

  if (rows[0]) return rows[0];

  return saveEntity(
    'workflow',
    {
      id: `workflow-${clientId}`,
      clientId,
      stage: 'enquiry',
      history: [],
      checklist: {},
      createdAt: now(),
      updatedAt: now(),
      persisted: true
    },
    reqActor,
    'workflow_created'
  );
}

export function syncClientWorkflow(
  clientId: string,
  stage: WorkflowStage,
  reqActor?: {id:string;role:string},
  reason = ''
) {
  const current = ensureWorkflow(clientId, reqActor);

  if (current.stage === stage) {
    return current;
  }

  return advanceWorkflow(clientId, stage, reqActor, reason);
}

export function advanceWorkflow(
  clientId: string,
  stage: WorkflowStage,
  reqActor?: {id:string;role:string},
  reason = ''
) {
  const current = workflowFor(clientId);
  const history = Array.isArray(current.history) ? current.history : [];

  const entry = {
    from: current.stage || null,
    to: stage,
    reason,
    timestamp: now(),
    actorId: reqActor?.id || 'system'
  };

  const updated = {
    ...current,
    clientId,
    stage,
    history: [...history, entry],
    updatedAt: now()
  };

  const result = saveEntity(
    'workflow',
    updated,
    reqActor,
    'workflow_advanced'
  );

  enqueueNotification(
    `workflow_${stage}`,
    clientId,
    {
      clientId,
      stage,
      reason
    }
  );

  return result;
}

export function createTask(
  clientId: string,
  task: any,
  reqActor?: {id:string;role:string}
) {
  return saveEntity(
    'workflow_task',
    {
      id: task.id || id(),
      clientId,
      title: task.title,
      type: task.type || 'workflow',
      status: task.status || 'open',
      priority: task.priority || 'medium',
      dueAt: task.dueAt || null,
      entityType: task.entityType || null,
      entityId: task.entityId || null,
      notes: task.notes || '',
      createdAt: now(),
      updatedAt: now()
    },
    reqActor,
    'workflow_task_created'
  );
}

export function completeTask(
  taskId: string,
  reqActor?: {id:string;role:string},
  evidence?: any
) {
  const task = getEntity('workflow_task', taskId);
  if (!task) return null;

  return saveEntity(
    'workflow_task',
    {
      ...task,
      status: 'completed',
      completedAt: now(),
      evidence: evidence || null,
      updatedAt: now()
    },
    reqActor,
    'workflow_task_completed'
  );
}

export function createAction(
  clientId: string,
  action: any,
  reqActor?: {id:string;role:string}
) {
  return saveEntity(
    'action',
    {
      id: action.id || id(),
      clientId,
      title: action.title || 'Fire safety action',
      description: action.description || '',
      risk: action.risk || 'Medium',
      priority: action.priority || action.risk || 'Medium',
      timescale: action.timescale || '3 months',
      targetDate: action.targetDate || null,
      responsiblePerson: action.responsiblePerson || '',
      status: action.status || 'open',
      evidence: action.evidence || [],
      source: action.source || 'FRA',
      createdAt: now(),
      updatedAt: now()
    },
    reqActor,
    'action_created'
  );
}

export function client360(clientId: string) {
  const client = getEntity('client', clientId) || getEntity('clients', clientId);

  const premises = listEntities('premise', clientId, 'all')
    .concat(listEntities('premises', clientId, 'all'));

  const quotes = listEntities('quote', clientId, 'all')
    .concat(listEntities('quotes', clientId, 'all'));

  const invoices = listEntities('invoice', clientId, 'all')
    .concat(listEntities('invoices', clientId, 'all'));

  const bookings = listEntities('booking', clientId, 'all')
    .concat(listEntities('bookings', clientId, 'all'));

  const assessments = listEntities('assessment', clientId, 'all')
    .concat(listEntities('assessments', clientId, 'all'));

  const documents = listEntities('document', clientId, 'all')
    .concat(listEntities('documents', clientId, 'all'));

  const actions = listEntities('action', clientId, 'all');

  const tasks = listEntities('workflow_task', clientId, 'all');

  return {
    client,
    workflow: workflowFor(clientId),
    premises,
    quotes,
    invoices,
    bookings,
    assessments,
    documents,
    actions,
    tasks
  };
}

export function runClientAutomation(
  clientId: string,
  reqActor?: {id:string;role:string}
) {
  const c360 = client360(clientId);
  const current = c360.workflow;
  const stage = current.stage;

  /*
    CENTRAL WORKFLOW OVERRIDE

    Automation is state-derived. Individual routes should record
    facts; this function determines the resulting workflow stage.
    Never move a client backwards because a late/duplicate event
    was processed.
  */
  const currentIndex = WORKFLOW_STAGES.indexOf(
    stage as WorkflowStage
  );

  const quote = c360.quotes.find((q:any) =>
    ['accepted','approved'].includes(String(q.status).toLowerCase())
  );

  const termsSigned = c360.tasks.some((t:any) =>
    String(t.type || '').toLowerCase() === 'terms' &&
    ['completed','complete','signed','accepted'].includes(String(t.status).toLowerCase())
  );

  const onboardingComplete = c360.tasks.some((t:any) =>
    String(t.type || '').toLowerCase() === 'onboarding' &&
    ['completed','complete','submitted'].includes(String(t.status).toLowerCase())
  );

  const paidInvoice = c360.invoices.some((i:any) =>
    ['paid','succeeded','complete'].includes(String(i.status).toLowerCase())
  );

  const confirmedBooking = c360.bookings.some((b:any) =>
    ['confirmed','booked','scheduled'].includes(String(b.status).toLowerCase())
  );

  const completedAssessment = c360.assessments.some((a:any) =>
    ['completed','complete'].includes(String(a.status).toLowerCase())
  );

  const finalReport = c360.documents.some((d:any) => {
    const text = String(
      d.type || d.category || d.documentType || d.name || ''
    ).toLowerCase();
    return text.includes('report') || text.includes('fra');
  });

  const openActions = c360.actions.filter((a:any) =>
    !['completed','closed'].includes(String(a.status).toLowerCase())
  );

  if (
    finalReport &&
    completedAssessment &&
    openActions.length === 0 &&
    stage !== 'complete'
  ) {
    return advanceWorkflow(
      clientId,
      'complete',
      reqActor,
      'Report complete and no open actions'
    );
  }

  if (finalReport && stage !== 'actions' && stage !== 'complete') {
    return advanceWorkflow(clientId,'actions',reqActor,'Final report available');
  }

  if (completedAssessment && !finalReport && stage !== 'report') {
    return advanceWorkflow(clientId,'report',reqActor,'Assessment completed');
  }

  if (confirmedBooking && !completedAssessment && stage !== 'assessment') {
    return advanceWorkflow(clientId,'assessment',reqActor,'Booking confirmed');
  }

  if (paidInvoice && !['ready_to_book','booked','assessment','report','actions','complete'].includes(stage)) {
    return advanceWorkflow(clientId,'ready_to_book',reqActor,'Payment received');
  }

  if (onboardingComplete && !paidInvoice && !['payment','ready_to_book','booked','assessment','report','actions','complete'].includes(stage)) {
    return advanceWorkflow(clientId,'payment',reqActor,'Onboarding completed; payment required');
  }

  if (termsSigned && !onboardingComplete && !['onboarding','payment','ready_to_book','booked','assessment','report','actions','complete'].includes(stage)) {
    return advanceWorkflow(clientId,'onboarding',reqActor,'Terms signed; onboarding required');
  }

  if (quote && stage === 'quote') {
    return advanceWorkflow(clientId,'accepted',reqActor,'Quote accepted');
  }

  return current;
}

export function generateQuoteFromPremise(
  clientId: string,
  premise: any,
  reqActor?: {id:string;role:string}
) {
  const floors = Number(premise?.floors || premise?.numberOfFloors || 1);
  const size = Number(
    premise?.largestFloorSqFt ||
    premise?.floorAreaSqFt ||
    premise?.sizeSqFt ||
    premise?.areaSqFt ||
    0
  );

  const sleeping = !!(
    premise?.sleepingAccommodation ||
    premise?.sleeping ||
    premise?.useType === 'sleeping'
  );

  if (sleeping) {
    return {
      service: 'manual_review',
      price: null,
      reason: 'Sleeping accommodation requires separate assessment review.'
    };
  }

  let service = 'Small';
  let price = 345;

  if (floors >= 4 || size > 9000) {
    service = 'Complex';
    price = 995;
  } else if (floors >= 3 || size > 6000) {
    service = 'Larger';
    price = 695;
  } else if (floors >= 2 || size > 3000) {
    service = 'Standard';
    price = 495;
  }

  const quote = saveEntity(
    'quote',
    {
      id: id(),
      clientId,
      premiseId: premise?.id || null,
      service,
      amount: price,
      currency: 'GBP',
      vatShown: false,
      status: 'draft',
      pricingSource: 'Aurelius fixed pricing',
      createdAt: now(),
      updatedAt: now()
    },
    reqActor,
    'automatic_quote_created'
  );

  return quote;
}

export function createEnquiryPipeline(
  input: any,
  reqActor?: {id:string;role:string}
) {
  const timestamp = now();

  const client = saveEntity(
    'client',
    {
      id: input.clientId || id(),
      name: input.clientName || input.name || '',
      email: input.email || '',
      phone: input.phone || '',
      company: input.company || '',
      source: input.source || 'website',
      status: 'active',
      createdAt: timestamp
    },
    reqActor,
    'website_enquiry_client_created'
  );

  const premise = saveEntity(
    'premise',
    {
      id: input.premiseId || id(),
      clientId: client.id,
      name: input.premiseName || input.businessName || 'Premises',
      address: input.address || '',
      postcode: input.postcode || '',
      floors: input.floors || 1,
      floorAreaSqFt: input.floorAreaSqFt || input.sizeSqFt || '',
      useType: input.useType || '',
      occupancy: input.occupancy || '',
      sleepingAccommodation: !!input.sleepingAccommodation,
      source: 'website_enquiry',
      status: 'active',
      createdAt: timestamp
    },
    reqActor,
    'website_enquiry_premise_created'
  );

  const enquiry = saveEntity(
    'enquiry',
    {
      id: id(),
      clientId: client.id,
      premiseId: premise.id,
      status: 'new',
      source: input.source || 'website',
      message: input.message || '',
      createdAt: timestamp
    },
    reqActor,
    'website_enquiry_created'
  );

  const quote = generateQuoteFromPremise(client.id, premise, reqActor);

  let workflow = ensureWorkflow(client.id, reqActor);

  if (quote?.amount) {
    workflow = syncClientWorkflow(
      client.id,
      'quote',
      reqActor,
      'Automatic fixed quote generated'
    );
  }

  enqueueNotification(
    'new_enquiry',
    client.email,
    {
      clientId: client.id,
      premiseId: premise.id,
      quoteId: quote?.id || null
    }
  );

  return {
    client,
    premise,
    enquiry,
    quote,
    workflow
  };
}

export function createOnboardingTasks(
  clientId: string,
  reqActor?: {id:string;role:string}
) {
  const existing = listEntities('workflow_task', clientId, 'all');

  const required = [
    ['Terms & engagement', 'terms'],
    ['Client onboarding form', 'onboarding'],
    ['EICR / electrical documentation', 'previsit'],
    ['Gas certificate where applicable', 'previsit'],
    ['Fire alarm servicing / commissioning records', 'previsit'],
    ['Emergency lighting records', 'previsit']
  ];

  for (const [title, type] of required) {
    if (!existing.some((x:any) => x.title === title && x.status !== 'cancelled')) {
      createTask(clientId, {
        title,
        type,
        priority: 'medium',
        status: 'open'
      }, reqActor);
    }
  }

  return listEntities('workflow_task', clientId, 'all');
}

export function createBookingTasks(
  clientId: string,
  bookingId: string,
  reqActor?: {id:string;role:string}
) {
  const existing = listEntities('workflow_task', clientId, 'all');

  const required = [
    'Confirm access arrangements',
    'Confirm Responsible Person / representative',
    'Upload requested compliance certificates',
    'Confirm premises will be accessible',
    'Confirm assessment appointment'
  ];

  for (const title of required) {
    if (!existing.some((x:any) => x.title === title && x.status !== 'cancelled')) {
      createTask(clientId, {
        title,
        type: 'previsit',
        entityType: 'booking',
        entityId: bookingId,
        priority: 'medium'
      }, reqActor);
    }
  }

  return listEntities('workflow_task', clientId, 'all');
}

export function actionSummary(clientId?: string) {
  const actions = clientId
    ? listEntities('action', clientId, 'all')
    : listEntities('action', undefined, 'all');

  const today = new Date();
  const dueSoon = new Date(today.getTime() + 14 * 86400000);

  return {
    total: actions.length,
    open: actions.filter((a:any) => !['completed','closed'].includes(a.status)).length,
    completed: actions.filter((a:any) => ['completed','closed'].includes(a.status)).length,
    overdue: actions.filter((a:any) =>
      !['completed','closed'].includes(a.status) &&
      a.targetDate &&
      new Date(a.targetDate) < today
    ).length,
    dueSoon: actions.filter((a:any) =>
      !['completed','closed'].includes(a.status) &&
      a.targetDate &&
      new Date(a.targetDate) >= today &&
      new Date(a.targetDate) <= dueSoon
    ).length
  };
}

export function dashboardSummary() {
  const workflows = listEntities('workflow', undefined, 'all');
  const tasks = listEntities('workflow_task', undefined, 'all');
  const actions = listEntities('action', undefined, 'all');

  const result:any = {
    totalClients: listEntities('client', undefined, 'all').length +
      listEntities('clients', undefined, 'all').length,
    enquiries: 0,
    quotes: 0,
    accepted: 0,
    terms: 0,
    onboarding: 0,
    payment: 0,
    readyToBook: 0,
    booked: 0,
    assessment: 0,
    report: 0,
    actions: 0,
    complete: 0,
    openTasks: tasks.filter((x:any) => !['completed','cancelled'].includes(x.status)).length,
    overdueTasks: 0,
    overdueActions: 0
  };

  for (const w of workflows) {
    switch (w.stage) {
      case 'enquiry': result.enquiries++; break;
      case 'quote': result.quotes++; break;
      case 'accepted': result.accepted++; break;
      case 'terms': result.terms++; break;
      case 'onboarding': result.onboarding++; break;
      case 'payment': result.payment++; break;
      case 'ready_to_book': result.readyToBook++; break;
      case 'booked': result.booked++; break;
      case 'assessment': result.assessment++; break;
      case 'report': result.report++; break;
      case 'actions': result.actions++; break;
      case 'complete': result.complete++; break;
    }
  }

  const today = new Date();

  for (const t of tasks) {
    if (
      !['completed','cancelled'].includes(t.status) &&
      t.dueAt &&
      new Date(t.dueAt) < today
    ) {
      result.overdueTasks++;
    }
  }

  result.overdueActions = actionSummary().overdue;

  return result;
}

export function processAutomation() {
  const clients = listEntities('client', undefined, 'all')
    .concat(listEntities('clients', undefined, 'all'));

  const results:any[] = [];

  for (const client of clients) {
    try {
      results.push(runClientAutomation(client.id));
    } catch {
      // One client's workflow must never stop processing other clients.
    }
  }

  return {
    processed: clients.length,
    results,
    timestamp: now()
  };
}
