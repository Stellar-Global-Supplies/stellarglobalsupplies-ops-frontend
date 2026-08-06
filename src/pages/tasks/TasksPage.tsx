import EmailCampaignWidget from '@/components/EmailCampaignWidget';

export default function TasksPage() {
  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-100">Tasks</h1>
        <p className="text-sm text-slate-400 mt-1">Manage campaigns and automation</p>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <EmailCampaignWidget />
      </div>
    </div>
  );
}