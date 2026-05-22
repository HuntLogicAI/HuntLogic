"use client";

import { useState, useEffect, useCallback } from "react";
import { Bell, Globe, User, Shield, Download, Check, Link2, ChevronRight, Trash2 } from "lucide-react";
import { apiClient } from "@/lib/api/client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PushNotificationToggle } from "@/components/settings/PushNotificationToggle";

interface NotifPrefs {
  emailEnabled: boolean;
  pushEnabled: boolean;
  deadlineReminders: boolean;
  drawResults: boolean;
  strategyUpdates: boolean;
  pointCreepAlerts: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
}

interface ProfileData {
  displayName: string;
  email: string;
  timezone: string;
}

const TIMEZONE_OPTIONS = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
];

export default function SettingsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notifPrefs, setNotifPrefs] = useState<NotifPrefs>({
    emailEnabled: true,
    pushEnabled: true,
    deadlineReminders: true,
    drawResults: true,
    strategyUpdates: true,
    pointCreepAlerts: true,
    quietHoursStart: null,
    quietHoursEnd: null,
  });
  const [profile, setProfile] = useState<ProfileData>({
    displayName: "",
    email: "",
    timezone: "America/Denver",
  });
  const [dirty, setDirty] = useState(false);

  const fetchSettings = useCallback(async () => {
    try {
      const [notifRes, profileRes] = await Promise.all([
        apiClient.get<{ preferences: NotifPrefs }>("/notifications/preferences"),
        apiClient.get<{ data: ProfileData }>("/profile"),
      ]);
      if (notifRes.data?.preferences) setNotifPrefs(notifRes.data.preferences);
      if (profileRes.data?.data) {
        const p = profileRes.data.data;
        setProfile({
          displayName: p.displayName ?? "",
          email: p.email ?? "",
          timezone: p.timezone ?? "America/Denver",
        });
      }
    } catch (err) {
      console.error("[settings] Load failed:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await Promise.all([
        apiClient.put("/notifications/preferences", notifPrefs),
        apiClient.post("/profile", {
          displayName: profile.displayName,
          timezone: profile.timezone,
        }),
      ]);
      setDirty(false);
    } catch (err) {
      console.error("[settings] Save failed:", err);
    } finally {
      setSaving(false);
    }
  };

  const updateNotif = (key: keyof NotifPrefs, value: boolean) => {
    setNotifPrefs((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div><h1 className="text-2xl font-bold text-brand-forest dark:text-brand-cream">Settings</h1></div>
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-32 motion-safe:animate-pulse rounded-xl bg-brand-sage/10" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-brand-forest dark:text-brand-cream">Settings</h1>
          <p className="mt-1 text-sm text-brand-sage">Manage your account and notification preferences</p>
        </div>
        {dirty && (
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 rounded-[8px] bg-gradient-cta px-4 py-2 text-sm font-semibold text-white shadow-sm hover:-translate-y-0.5 hover:shadow-md disabled:opacity-50"
          >
            <Check className="h-4 w-4" />
            {saving ? "Saving..." : "Save"}
          </button>
        )}
      </div>

      {/* Profile */}
      <SettingsCard icon={User} title="Profile">
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-brand-bark dark:text-brand-cream">Display Name</label>
            <input
              type="text"
              value={profile.displayName}
              onChange={(e) => { setProfile((p) => ({ ...p, displayName: e.target.value })); setDirty(true); }}
              className="mt-1 w-full rounded-[10px] border border-[#E0DDD5] bg-white px-4 py-3 text-sm text-brand-bark outline-none focus:border-brand-forest dark:bg-brand-bark dark:text-brand-cream dark:border-brand-sage/30"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-brand-bark dark:text-brand-cream">Email</label>
            <p className="mt-1 text-sm text-brand-sage">{profile.email}</p>
          </div>
        </div>
      </SettingsCard>

      {/* Timezone */}
      <SettingsCard icon={Globe} title="Timezone">
        <select
          value={profile.timezone}
          onChange={(e) => { setProfile((p) => ({ ...p, timezone: e.target.value })); setDirty(true); }}
          className="w-full rounded-[10px] border border-[#E0DDD5] bg-white px-4 py-3 text-sm text-brand-bark outline-none focus:border-brand-forest dark:bg-brand-bark dark:text-brand-cream dark:border-brand-sage/30"
        >
          {TIMEZONE_OPTIONS.map((tz) => (
            <option key={tz} value={tz}>{tz.replace("_", " ").replace("America/", "")}</option>
          ))}
        </select>
      </SettingsCard>

      {/* Notifications */}
      <SettingsCard icon={Bell} title="Notifications">
        <div className="space-y-3">
          <ToggleRow label="Email Notifications" description="Receive alerts via email" checked={notifPrefs.emailEnabled} onChange={(v) => updateNotif("emailEnabled", v)} />
          <ToggleRow label="Deadline Reminders" description="Alerts for upcoming application deadlines" checked={notifPrefs.deadlineReminders} onChange={(v) => updateNotif("deadlineReminders", v)} />
          <ToggleRow label="Draw Results" description="Notifications when draw results are posted" checked={notifPrefs.drawResults} onChange={(v) => updateNotif("drawResults", v)} />
          <ToggleRow label="Strategy Updates" description="When your recommendations change" checked={notifPrefs.strategyUpdates} onChange={(v) => updateNotif("strategyUpdates", v)} />
          <ToggleRow label="Point Creep Alerts" description="When point requirements shift significantly" checked={notifPrefs.pointCreepAlerts} onChange={(v) => updateNotif("pointCreepAlerts", v)} />
          {/* Browser push opt-in — per-device, independent of the email + in-app channels above */}
          <div className="border-t border-brand-sage/10 pt-3 dark:border-brand-sage/20">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-brand-sage">
              Browser push (this device)
            </p>
            <PushNotificationToggle />
          </div>
        </div>
      </SettingsCard>

      {/* State Accounts */}
      <SettingsCard icon={Link2} title="State Accounts">
        <Link
          href="/settings/accounts"
          className="flex min-h-[44px] items-center justify-between rounded-[10px] border border-brand-sage/20 px-4 py-3 text-sm text-brand-bark transition-colors hover:bg-brand-sage/5 dark:text-brand-cream dark:border-brand-sage/30 dark:hover:bg-brand-sage/10"
        >
          <span>Manage State Accounts</span>
          <ChevronRight className="h-4 w-4 text-brand-sage" />
        </Link>
      </SettingsCard>

      {/* Data & Privacy */}
      <SettingsCard icon={Shield} title="Data & Privacy">
        <div className="space-y-3">
          <button
            onClick={async () => {
              try {
                const res = await fetch("/api/v1/profile/export");
                if (!res.ok) throw new Error("Export failed");
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `huntlogic-export-${new Date().toISOString().slice(0, 10)}.json`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
              } catch (err) {
                console.error("[settings] Export failed:", err);
              }
            }}
            className="flex min-h-[44px] w-full items-center gap-3 rounded-[10px] border border-brand-sage/20 px-4 py-3 text-sm text-brand-bark transition-colors hover:bg-brand-sage/5 dark:text-brand-cream dark:hover:bg-brand-sage/10"
          >
            <Download className="h-4 w-4 text-brand-sage" />
            Export My Data
          </button>
          <button
            onClick={async () => {
              const confirmed = window.confirm(
                "Are you sure you want to delete your account? This action is permanent and cannot be undone."
              );
              if (!confirmed) return;
              try {
                const res = await fetch("/api/v1/profile/delete", { method: "DELETE" });
                if (!res.ok) throw new Error("Delete failed");
                router.push("/login");
              } catch (err) {
                console.error("[settings] Delete failed:", err);
              }
            }}
            className="flex min-h-[44px] w-full items-center gap-3 rounded-[10px] border border-red-300 px-4 py-3 text-sm text-red-500 transition-colors hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
          >
            <Trash2 className="h-4 w-4" />
            Delete Account
          </button>
        </div>
      </SettingsCard>
    </div>
  );
}

function SettingsCard({ icon: Icon, title, children }: { icon: React.ElementType; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-brand-sage/10 bg-white p-6 dark:bg-brand-bark dark:border-brand-sage/20">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-forest/10 dark:bg-brand-sage/20">
          <Icon className="h-5 w-5 text-brand-forest dark:text-brand-sage" />
        </div>
        <h3 className="text-lg font-semibold text-brand-bark dark:text-brand-cream">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function ToggleRow({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <div>
        <p className="text-sm font-medium text-brand-bark dark:text-brand-cream">{label}</p>
        <p className="text-xs text-brand-sage">{description}</p>
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
          checked ? "bg-brand-forest" : "bg-brand-sage/30"
        }`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
            checked ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}
