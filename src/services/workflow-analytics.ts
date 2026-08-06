/**
 * Workflow Analytics Service
 * Queries Supabase tables. All queries are individually fault-tolerant —
 * if a table doesn't exist yet (404) or returns an error, that section
 * returns empty/zero data and the dashboard renders gracefully.
 */

import { supabase } from '@/lib/supabase';
import type { WorkflowAnalyticsData } from '@/types';

export interface DashboardData {
  leads:            { total: number; by_status: Record<string, number> };
  social_posts:     { total: number; by_status: Record<string, number> };
  blogs:            { total: number; by_status: Record<string, number> };
  pending_approvals: number;
  cost:             { total_usd: number; by_type: Record<string, number> };
  workflow_runs: Array<{
    id: string; workflow_type: string; status: string;
    started_at: string; completed_at?: string; cost_usd?: string;
  }>;
}

// Safely query a table — returns [] on any error (including 404 table not found)
async function safeQuery<T>(
  query: ReturnType<typeof supabase.from>,
  label: string,
): Promise<T[]> {
  try {
    const { data, error } = await (query as unknown as Promise<{ data: T[] | null; error: { message: string } | null }>);
    if (error) {
      console.warn(`[workflow] ${label} query skipped: ${error.message}`);
      return [];
    }
    return data ?? [];
  } catch (e) {
    console.warn(`[workflow] ${label} query failed:`, e);
    return [];
  }
}

type Lead         = { status: string; created_at: string; industry?: string };
type SocialPost   = { type: string; platform?: string; platforms?: Record<string, boolean>; status: string; created_at: string; posted_at?: string; video_url?: string; media_type?: string };
type BlogPost     = { status: string; tags?: string[]; created_at: string };
type Approval     = { workflow_type: string; status: string; created_at: string; reviewed_at?: string };
type WorkflowRun  = { id: string; workflow_type: string; status: string; started_at: string; completed_at?: string; cost_usd?: string };

async function fetchAll() {
  const [leads, socialPosts, blogs, approvals, workflowRuns] = await Promise.all([
    safeQuery<Lead>(
      supabase.from('leads').select('status, created_at, industry') as unknown as ReturnType<typeof supabase.from>,
      'leads',
    ),
    safeQuery<SocialPost>(
      supabase.from('ops_social_posts').select('type, platform, platforms, status, created_at, posted_at, video_url, media_type') as unknown as ReturnType<typeof supabase.from>,
      'ops_social_posts',
    ),
    safeQuery<BlogPost>(
      supabase.from('blog_posts').select('status, tags, created_at') as unknown as ReturnType<typeof supabase.from>,
      'blog_posts',
    ),
    safeQuery<Approval>(
      supabase.from('approval_queue').select('workflow_type, status, created_at, reviewed_at') as unknown as ReturnType<typeof supabase.from>,
      'approval_queue',
    ),
    safeQuery<WorkflowRun>(
      (supabase.from('workflow_runs').select('id, workflow_type, status, started_at, completed_at, cost_usd').order('started_at', { ascending: false }).limit(500)) as unknown as ReturnType<typeof supabase.from>,
      'workflow_runs',
    ),
  ]);
  return { leads, socialPosts, blogs, approvals, workflowRuns };
}

export async function fetchDashboard(): Promise<DashboardData> {
  const { leads, socialPosts, blogs, approvals, workflowRuns } = await fetchAll();

  const byStatus      = leads.reduce((a, l) => { a[l.status] = (a[l.status] || 0) + 1; return a; }, {} as Record<string, number>);
  const postByStatus  = socialPosts.reduce((a, p) => { a[p.status] = (a[p.status] || 0) + 1; return a; }, {} as Record<string, number>);
  const blogByStatus  = blogs.reduce((a, b) => { a[b.status] = (a[b.status] || 0) + 1; return a; }, {} as Record<string, number>);
  const pendingApprovals = approvals.filter(a => a.status === 'pending').length;

  return {
    leads:            { total: leads.length, by_status: byStatus },
    social_posts:     { total: socialPosts.length, by_status: postByStatus },
    blogs:            { total: blogs.length, by_status: blogByStatus },
    pending_approvals: pendingApprovals,
    cost:             { total_usd: 0, by_type: {} },
    workflow_runs: workflowRuns.slice(0, 20).map(r => ({
      id: r.id, workflow_type: r.workflow_type, status: r.status, started_at: r.started_at,
      completed_at: r.completed_at ?? undefined, cost_usd: r.cost_usd ?? undefined,
    })),
  };
}

export async function fetchWorkflowAnalytics(_range: number): Promise<WorkflowAnalyticsData> {
  const { leads, socialPosts, blogs, approvals, workflowRuns } = await fetchAll();

  const weekAgo      = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyAgo    = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // ── Leads ─────────────────────────────────────────────────────────────────
  const leadByStatus = leads.reduce((a, l) => { a[l.status] = (a[l.status] || 0) + 1; return a; }, {} as Record<string, number>);
  const recentLeads  = leads.filter(l => l.created_at >= thirtyAgo).length;
  const convRate     = leads.length > 0 ? ((leadByStatus.converted || 0) / leads.length) * 100 : 0;

  // ── Social posts ──────────────────────────────────────────────────────────
  const postByStatus    = socialPosts.reduce((a, p) => { a[p.status] = (a[p.status] || 0) + 1; return a; }, {} as Record<string, number>);
  const postByType      = socialPosts.reduce((a, p) => { a[p.type]   = (a[p.type]   || 0) + 1; return a; }, {} as Record<string, number>);
  const platformCounts  = socialPosts.reduce((a, p) => {
    const pl = p.platforms ?? {};
    if (pl.linkedin)  a.linkedin  = (a.linkedin  || 0) + 1;
    if (pl.facebook)  a.facebook  = (a.facebook  || 0) + 1;
    if (pl.instagram) a.instagram = (a.instagram || 0) + 1;
    return a;
  }, {} as Record<string, number>);
  const publishedWeek = socialPosts.filter(p => p.posted_at && p.posted_at >= weekAgo).length;
  const inPipeline    = (postByStatus.pending_approval || 0) + (postByStatus.publishing || 0);

  // ── Blogs ─────────────────────────────────────────────────────────────────
  const blogByStatus = blogs.reduce((a, b) => { a[b.status] = (a[b.status] || 0) + 1; return a; }, {} as Record<string, number>);
  const publishedRate = blogs.length > 0 ? ((blogByStatus.published || 0) / blogs.length) * 100 : 0;
  const tagCounts    = blogs.reduce((a, b) => { (b.tags ?? []).forEach(t => { a[t] = (a[t] || 0) + 1; }); return a; }, {} as Record<string, number>);
  const topTags      = Object.entries(tagCounts).sort(([,a],[,b]) => b - a).slice(0, 8).map(([tag, count]) => ({ tag, count }));

  // ── Approvals ─────────────────────────────────────────────────────────────
  const reviewed   = approvals.filter(a => ['approved','rejected'].includes(a.status));
  const approved   = approvals.filter(a => a.status === 'approved');
  const approvalRate = reviewed.length > 0 ? (approved.length / reviewed.length) * 100 : 0;
  const reviewTimes  = reviewed.filter(a => a.reviewed_at).map(a => new Date(a.reviewed_at!).getTime() - new Date(a.created_at).getTime());
  const avgReviewHrs = reviewTimes.length > 0 ? reviewTimes.reduce((s, t) => s + t, 0) / reviewTimes.length / 3_600_000 : 0;
  const byWorkflowType = approvals.reduce((a, x) => { a[x.workflow_type] = (a[x.workflow_type] || 0) + 1; return a; }, {} as Record<string, number>);

  // ── Workflow runs ─────────────────────────────────────────────────────────
  const succeeded = workflowRuns.filter(r => r.status === 'succeeded').length;
  const failed    = workflowRuns.filter(r => r.status === 'failed').length;
  const running   = workflowRuns.filter(r => r.status === 'running').length;

  const rateMap: Record<string, { succeeded: number; total: number }> = {};
  for (const r of workflowRuns) {
    rateMap[r.workflow_type] ??= { succeeded: 0, total: 0 };
    rateMap[r.workflow_type].total++;
    if (r.status === 'succeeded') rateMap[r.workflow_type].succeeded++;
  }
  const successRateByType = Object.entries(rateMap).map(([workflow_type, d]) => ({
    workflow_type, ...d, rate: d.total > 0 ? (d.succeeded / d.total) * 100 : 0,
  }));

  const durations = workflowRuns.filter(r => r.completed_at && r.started_at).map(r =>
    new Date(r.completed_at!).getTime() - new Date(r.started_at).getTime()
  );
  const avgDurationMin = durations.length > 0 ? durations.reduce((s, d) => s + d, 0) / durations.length / 60_000 : 0;

  const dailyRunMap: Record<string, { succeeded: number; failed: number; running: number }> = {};
  for (const r of workflowRuns) {
    const day = r.started_at?.slice(0, 10); if (!day) continue;
    dailyRunMap[day] ??= { succeeded: 0, failed: 0, running: 0 };
    if (r.status === 'succeeded') dailyRunMap[day].succeeded++;
    if (r.status === 'failed')    dailyRunMap[day].failed++;
    if (r.status === 'running')   dailyRunMap[day].running++;
  }
  const runDaily30 = Array.from({ length: 30 }, (_, i) => {
    const d   = new Date(Date.now() - (29 - i) * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    return { date: key, ...(dailyRunMap[key] ?? { succeeded: 0, failed: 0, running: 0 }) };
  });

  return {
    leads: {
      total: leads.length, recent30: recentLeads, by_status: leadByStatus,
      conversion_rate: convRate, by_industry: [], daily_30: [],
      emails_sent: 0, follow_ups: 0, initial_emails: 0,
    },
    social_posts: {
      total: socialPosts.length, by_status: postByStatus, by_type: postByType,
      platform_counts: platformCounts, published_week: publishedWeek,
      in_pipeline: inPipeline, ready_to_publish: postByStatus.approved_manual || 0, weekly_8: [],
    },
    blog_posts: {
      total: blogs.length, by_status: blogByStatus,
      published_rate: publishedRate, top_tags: topTags, monthly_6: [],
    },
    approvals: {
      pending: approvals.filter(a => a.status === 'pending').length,
      approval_rate: approvalRate, avg_review_hours: avgReviewHrs,
      expired: approvals.filter(a => a.status === 'expired').length,
      by_workflow_type: byWorkflowType, daily_30: [],
    },
    cost: { total_usd: 0, by_type: {} },
    workflow_runs: {
      total: workflowRuns.length, succeeded, failed, running,
      success_rate_by_type: successRateByType, avg_duration_min: avgDurationMin,
      active_runs: workflowRuns.filter(r => r.status === 'running').map(r => ({ workflow_type: r.workflow_type, started_at: r.started_at })),
      recent_failed: workflowRuns.filter(r => r.status === 'failed' && r.started_at >= weekAgo).map(r => ({ workflow_type: r.workflow_type, started_at: r.started_at })),
      daily_30: runDaily30,
      recent: workflowRuns.slice(0, 20).map(r => ({
        id: r.id, workflow_type: r.workflow_type, status: r.status,
        started_at: r.started_at, completed_at: r.completed_at ?? undefined, cost_usd: r.cost_usd ?? undefined,
      })),
    },
    schedules: { total: 0, active: 0, paused: 0, by_frequency: {}, by_type: {}, list: [] },
  };
}