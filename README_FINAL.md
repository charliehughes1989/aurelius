# Aurelius Fire + Coach CRM - Final Build

## Aurelius Fire (Live)
- / -> Main site with NW-only coverage, qualifications, H1, SEO 90+, a11y AA, canonical, OG tags
- /quote.html -> Works with and without token, instant price, accept/decline
- /portal -> Client portal with Stripe pay, bookings, documents
- Security: CSP, HSTS, X-Frame DENY, Permissions-Policy, Referrer-Policy, single Stripe webhook idempotent
- Stripe: /api/stripe-checkout/create + /api/stripe-checkout/webhook (verified, webhook_events table)

## Coach CRM - Ultimate Online Coach SaaS (Premium)
- /coach/ -> Full CRM: Dashboard (real KPIs), Leads (30 samples), Pipeline Kanban drag-drop, Clients, Calendar, Tasks, Payments, Programmes, Follow-Ups, Quick Add cmd+k
- /coach/automations.html -> Automation builder, Email templates {{first_name}}, Reports with CSV export, AI Daily Brief

Journey: TRAFFIC -> LEAD -> QUALIFIED -> CALL -> FOLLOW-UP -> SALE -> PAYMENT -> ONBOARDING -> ACTIVE -> RETENTION -> RENEWAL

Stack: Bun + Express + SQLite, real state, no dead buttons, mobile responsive, GDPR ready, Stripe architecture.
