"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2, Store, Users, ShieldCheck, Boxes, Receipt, Plug, Palette, Database,
  Plus, KeyRound, Moon, Sun, Upload, Download, ImagePlus, Trash2,
} from "lucide-react";
import { PageHeader } from "@hamza/shared/ui/PageHeader";
import { Card, CardHeader, CardTitle, CardBody } from "@hamza/shared/ui/Card";
import { Button } from "@hamza/shared/ui/Button";
import { Input, Label, FieldError } from "@hamza/shared/ui/Input";
import { Select } from "@hamza/shared/ui/Select";
import { Drawer } from "@hamza/shared/ui/Drawer";
import { DataTable, type Column } from "@hamza/shared/ui/DataTable";
import { StatusPill } from "@hamza/shared/ui/StatusPill";
import { Avatar } from "@hamza/shared/ui/Avatar";
import { useToast } from "@hamza/shared/ui/Toast";
import { useTheme } from "@hamza/shared/theme/ThemeProvider";
import { cn } from "@hamza/shared/utils";
import { DEFAULT_RECEIPT_DISCLAIMER } from "@/lib/receipt-html";
import {
  updateStoreProfile, updateInventorySettings, updateSalesSettings, updateIntegrations,
  inviteUser, updateUserRole, setUserActive, resetUserPassword, changePassword,
  importProductsCSV, exportProductsCSV, uploadLogo, removeLogo,
} from "./actions";

const LOGO_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/avif"];
const LOGO_MAX_BYTES = 5_242_880; // 5 MB

export interface SettingsData {
  store_name: string; costing_method: "WEIGHTED_AVERAGE" | "FIFO"; tax_percent: number; currency: string;
  address: string; phone: string; ntn: string; receipt_header: string; receipt_footer: string; logo_url: string;
  /** Phase F — disclaimer printed on every receipt. Blank = built-in default. */
  receipt_disclaimer: string;
  /** Phase H — days a sale stays returnable (0 = no limit). */
  return_window_days: number;
  low_stock_default: number; barcode_format: string; default_unit: string;
  rounding: string; receipt_template: string; allow_discounts: boolean;
  courier: Record<string, string>; resend_key: string; whatsapp_key: string; from_email: string; notif_prefs: Record<string, unknown>;
}
export interface UserRow { id: string; full_name: string; role: string; active: boolean; email: string }

const SECTIONS = [
  { key: "store", label: "Store profile", icon: Store },
  { key: "users", label: "Users & roles", icon: Users },
  { key: "security", label: "Security", icon: ShieldCheck },
  { key: "inventory", label: "Inventory", icon: Boxes },
  { key: "sales", label: "Sales", icon: Receipt },
  { key: "integrations", label: "Integrations", icon: Plug },
  { key: "appearance", label: "Appearance", icon: Palette },
  { key: "data", label: "Data", icon: Database },
] as const;
type SectionKey = typeof SECTIONS[number]["key"];

export function SettingsClient({ data, users, isOwner, myId }: { data: SettingsData; users: UserRow[]; isOwner: boolean; myId: string }) {
  const [section, setSection] = useState<SectionKey>("store");

  return (
    <div>
      <PageHeader title="Settings" subtitle="Store configuration, users, security and integrations" />
      <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
        <nav className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-surface p-2 lg:flex-col lg:overflow-visible">
          {SECTIONS.map((s) => (
            <button key={s.key} onClick={() => setSection(s.key)}
              className={cn("flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                section === s.key ? "bg-brand-500 text-white" : "text-text-secondary hover:bg-surface-2")}>
              <s.icon className="h-4 w-4" /> {s.label}
            </button>
          ))}
        </nav>

        <div>
          {section === "store" && <StoreSection data={data} isOwner={isOwner} />}
          {section === "users" && <UsersSection users={users} isOwner={isOwner} myId={myId} />}
          {section === "security" && <SecuritySection />}
          {section === "inventory" && <InventorySection data={data} isOwner={isOwner} />}
          {section === "sales" && <SalesSection data={data} isOwner={isOwner} />}
          {section === "integrations" && <IntegrationsSection data={data} isOwner={isOwner} />}
          {section === "appearance" && <AppearanceSection />}
          {section === "data" && <DataSection isOwner={isOwner} />}
        </div>
      </div>
    </div>
  );
}

function useSaver() {
  const router = useRouter();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  async function run(fn: () => Promise<{ ok?: boolean; error?: string } | undefined>, okMsg = "Saved") {
    setSaving(true);
    const res = await fn();
    setSaving(false);
    if (res?.error) { toast(res.error, "error"); return false; }
    toast(okMsg); router.refresh(); return true;
  }
  return { saving, run };
}

function OwnerNote({ isOwner }: { isOwner: boolean }) {
  if (isOwner) return null;
  return <p className="text-xs text-text-tertiary">Only the owner can edit these settings.</p>;
}

/* ---------------- Store profile ---------------- */
function StoreSection({ data, isOwner }: { data: SettingsData; isOwner: boolean }) {
  const { saving, run } = useSaver();
  const router = useRouter();
  const toast = useToast();
  const [f, setF] = useState(data);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const logoInput = useRef<HTMLInputElement>(null);
  const set = (k: keyof SettingsData) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  async function onLogoFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!LOGO_TYPES.includes(file.type)) return toast("Logo must be a PNG, JPG or WebP image.", "error");
    if (file.size > LOGO_MAX_BYTES) return toast("Logo must be under 5 MB.", "error");
    setUploadingLogo(true);
    const fd = new FormData();
    fd.append("file", file);
    const res = await uploadLogo(fd);
    setUploadingLogo(false);
    if ("error" in res) return toast(res.error, "error");
    // uploadLogo already persisted the new URL to the settings record, so just
    // sync local state and refresh so the header + invoices show it immediately.
    setF((s) => ({ ...s, logo_url: res.url }));
    router.refresh();
    toast("Logo updated");
  }

  async function onRemoveLogo() {
    setUploadingLogo(true);
    const res = await removeLogo();
    setUploadingLogo(false);
    if ("error" in res) return toast(res.error, "error");
    setF((s) => ({ ...s, logo_url: "" }));
    router.refresh();
    toast("Logo removed");
  }

  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Store className="h-4 w-4" /> Store profile</CardTitle></CardHeader>
      <CardBody>
        <form onSubmit={(e) => { e.preventDefault(); run(() => updateStoreProfile({ store_name: f.store_name, currency: f.currency, tax_percent: Number(f.tax_percent) || 0, address: f.address, phone: f.phone, ntn: f.ntn, receipt_header: f.receipt_header, receipt_footer: f.receipt_footer, receipt_disclaimer: f.receipt_disclaimer, logo_url: f.logo_url })); }} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div><Label>Store name</Label><Input value={f.store_name} disabled={!isOwner} onChange={set("store_name")} /></div>
            <div><Label>Phone</Label><Input value={f.phone} disabled={!isOwner} onChange={set("phone")} /></div>
          </div>
          <div><Label>Address</Label><Input value={f.address} disabled={!isOwner} onChange={set("address")} /></div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div><Label>Currency</Label><Input value={f.currency} disabled={!isOwner} onChange={set("currency")} /></div>
            <div><Label>Tax / GST (%)</Label><Input type="number" value={f.tax_percent} disabled={!isOwner} onChange={set("tax_percent")} /></div>
            <div><Label>NTN / Tax #</Label><Input value={f.ntn} disabled={!isOwner} onChange={set("ntn")} /></div>
          </div>
          <div className="space-y-2">
            <Label>Store logo</Label>
            <div className="flex items-start gap-3">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface-2">
                {f.logo_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={f.logo_url} alt="Store logo" className="h-full w-full object-contain" />
                ) : (
                  <Store className="h-6 w-6 text-text-tertiary" />
                )}
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap gap-2">
                  <input ref={logoInput} type="file" accept="image/png,image/jpeg,image/webp,image/avif" className="hidden" onChange={onLogoFile} />
                  <Button type="button" variant="secondary" size="sm" disabled={!isOwner || uploadingLogo} onClick={() => logoInput.current?.click()}>
                    {uploadingLogo ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />} {f.logo_url ? "Replace" : "Upload"}
                  </Button>
                  {f.logo_url && (
                    <Button type="button" variant="ghost" size="sm" disabled={!isOwner || uploadingLogo} onClick={onRemoveLogo}>
                      <Trash2 className="h-4 w-4" /> Remove
                    </Button>
                  )}
                </div>
                <Input value={f.logo_url} disabled={!isOwner} onChange={set("logo_url")} placeholder="…or paste an image URL (https://…)" />
                <p className="text-[11px] text-text-tertiary">Upload a file (PNG/JPG/WebP up to 5 MB) and it applies immediately in the admin header and on invoices/receipts. To use a pasted image URL instead, click Save profile.</p>
              </div>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><Label>Receipt header</Label><Input value={f.receipt_header} disabled={!isOwner} onChange={set("receipt_header")} /></div>
            <div><Label>Receipt footer</Label><Input value={f.receipt_footer} disabled={!isOwner} onChange={set("receipt_footer")} placeholder="Thank you!" /></div>
            <div className="sm:col-span-2">
              <Label>Receipt disclaimer</Label>
              <Input value={f.receipt_disclaimer} disabled={!isOwner} onChange={set("receipt_disclaimer")} placeholder={DEFAULT_RECEIPT_DISCLAIMER} />
              <p className="mt-1 text-xs text-text-tertiary">
                Printed on every receipt, just above the footer. Leave blank to use the
                default: “{DEFAULT_RECEIPT_DISCLAIMER}”.
              </p>
            </div>
          </div>
          {isOwner ? <Button type="submit" disabled={saving || uploadingLogo}>{saving && <Loader2 className="h-4 w-4 animate-spin" />} Save profile</Button> : <OwnerNote isOwner={isOwner} />}
        </form>
      </CardBody>
    </Card>
  );
}

/* ---------------- Users & roles ---------------- */
function UsersSection({ users, isOwner, myId }: { users: UserRow[]; isOwner: boolean; myId: string }) {
  const { run } = useSaver();
  const toast = useToast();
  const [invite, setInvite] = useState(false);
  const [resetFor, setResetFor] = useState<UserRow | null>(null);

  const cols: Column<UserRow>[] = [
    { key: "full_name", header: "User", cell: (u) => (
      <div className="flex items-center gap-2.5"><Avatar name={u.full_name} size={32} />
        <div><div className="font-medium text-text-primary">{u.full_name}{u.id === myId && <span className="ml-1 text-xs text-text-tertiary">(you)</span>}</div>
          {u.email && <div className="text-xs text-text-tertiary">{u.email}</div>}</div></div>
    ) },
    { key: "role", header: "Role", cell: (u) => isOwner && u.id !== myId
      ? <Select value={u.role} onChange={(e) => run(() => updateUserRole(u.id, e.target.value as "owner" | "manager" | "cashier"), "Role updated")} className="h-8 w-32"><option value="owner">Owner</option><option value="manager">Manager</option><option value="cashier">Cashier</option></Select>
      : <StatusPill tone="blue">{u.role}</StatusPill> },
    { key: "active", header: "Status", cell: (u) => <StatusPill status={u.active ? "confirmed" : "cancelled"}>{u.active ? "Active" : "Disabled"}</StatusPill> },
    { key: "actions", header: "", align: "right", cell: (u) => isOwner ? (
      <div className="flex justify-end gap-1">
        <button onClick={() => setResetFor(u)} className="rounded-md p-1.5 text-text-tertiary hover:bg-surface-2" title="Reset password"><KeyRound className="h-4 w-4" /></button>
        {u.id !== myId && <Button size="sm" variant="secondary" onClick={() => run(() => setUserActive(u.id, !u.active), u.active ? "Deactivated" : "Activated")}>{u.active ? "Disable" : "Enable"}</Button>}
      </div>
    ) : null },
  ];

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle className="flex items-center gap-2"><Users className="h-4 w-4" /> Users & roles</CardTitle>
        {isOwner && <Button size="sm" onClick={() => setInvite(true)}><Plus className="h-4 w-4" /> Add staff</Button>}
      </CardHeader>
      <DataTable columns={cols} rows={users} />

      {invite && <InviteDrawer onClose={() => setInvite(false)} onDone={() => { setInvite(false); }} />}
      {resetFor && <ResetPwDrawer user={resetFor} onClose={() => setResetFor(null)} onDone={(m) => { setResetFor(null); toast(m); }} />}
    </Card>
  );
}

function InviteDrawer({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { saving, run } = useSaver();
  const [f, setF] = useState({ email: "", full_name: "", role: "cashier", password: "" });
  const [err, setErr] = useState<string>();
  return (
    <Drawer open onClose={onClose} title="Add staff member" footer={
      <div className="flex gap-2"><Button variant="secondary" className="flex-1" onClick={onClose}>Cancel</Button>
        <Button form="invite-form" type="submit" className="flex-1" disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin" />} Create</Button></div>
    }>
      <form id="invite-form" onSubmit={async (e) => { e.preventDefault(); setErr(undefined); const ok = await run(() => inviteUser({ email: f.email, full_name: f.full_name, role: f.role as "owner" | "manager" | "cashier", password: f.password }), "Staff added"); if (ok) onDone(); }} className="space-y-4">
        <div><Label>Full name</Label><Input value={f.full_name} onChange={(e) => setF((s) => ({ ...s, full_name: e.target.value }))} /></div>
        <div><Label>Email</Label><Input type="email" value={f.email} onChange={(e) => setF((s) => ({ ...s, email: e.target.value }))} /></div>
        <div><Label>Role</Label><Select value={f.role} onChange={(e) => setF((s) => ({ ...s, role: e.target.value }))}><option value="cashier">Cashier</option><option value="manager">Manager</option><option value="owner">Owner</option></Select></div>
        <div><Label>Temporary password</Label><Input type="text" value={f.password} onChange={(e) => setF((s) => ({ ...s, password: e.target.value }))} placeholder="min 8 chars" /></div>
        <p className="text-[11px] text-text-tertiary">Share this temporary password with the staff member; they can change it after signing in.</p>
        <FieldError message={err} />
      </form>
    </Drawer>
  );
}

function ResetPwDrawer({ user, onClose, onDone }: { user: UserRow; onClose: () => void; onDone: (m: string) => void }) {
  const [pw, setPw] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string>();
  return (
    <Drawer open onClose={onClose} title={`Reset password · ${user.full_name}`} footer={
      <div className="flex gap-2"><Button variant="secondary" className="flex-1" onClick={onClose}>Cancel</Button>
        <Button form="reset-form" type="submit" className="flex-1" disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin" />} Reset</Button></div>
    }>
      <form id="reset-form" onSubmit={async (e) => { e.preventDefault(); setErr(undefined); setSaving(true); const res = await resetUserPassword(user.id, pw); setSaving(false); if (res?.error) { setErr(res.error); return; } onDone("Password reset"); }} className="space-y-4">
        <div><Label>New temporary password</Label><Input type="text" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="min 8 chars" /></div>
        <FieldError message={err} />
      </form>
    </Drawer>
  );
}

/* ---------------- Security (change own password) ---------------- */
function SecuritySection() {
  const toast = useToast();
  const [f, setF] = useState({ current: "", next: "", confirm: "" });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string>();
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(undefined);
    if (f.next !== f.confirm) { setErr("New passwords don’t match."); return; }
    if (f.next.length < 8) { setErr("New password must be at least 8 characters."); return; }
    setSaving(true);
    const res = await changePassword(f.current, f.next);
    setSaving(false);
    if (res?.error) { setErr(res.error); return; }
    setF({ current: "", next: "", confirm: "" });
    toast("Password changed");
  }
  return (
    <Card className="max-w-md">
      <CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> Change password</CardTitle></CardHeader>
      <CardBody>
        <form onSubmit={submit} className="space-y-4">
          <div><Label>Current password</Label><Input type="password" value={f.current} onChange={(e) => setF((s) => ({ ...s, current: e.target.value }))} autoComplete="current-password" /></div>
          <div><Label>New password</Label><Input type="password" value={f.next} onChange={(e) => setF((s) => ({ ...s, next: e.target.value }))} autoComplete="new-password" /></div>
          <div><Label>Confirm new password</Label><Input type="password" value={f.confirm} onChange={(e) => setF((s) => ({ ...s, confirm: e.target.value }))} autoComplete="new-password" /></div>
          <FieldError message={err} />
          <Button type="submit" disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin" />} Update password</Button>
        </form>
      </CardBody>
    </Card>
  );
}

/* ---------------- Inventory ---------------- */
function InventorySection({ data, isOwner }: { data: SettingsData; isOwner: boolean }) {
  const { saving, run } = useSaver();
  const [f, setF] = useState(data);
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Boxes className="h-4 w-4" /> Inventory settings</CardTitle></CardHeader>
      <CardBody>
        <form onSubmit={(e) => { e.preventDefault(); run(() => updateInventorySettings({ costing_method: f.costing_method, low_stock_default: Number(f.low_stock_default) || 0, barcode_format: f.barcode_format, default_unit: f.default_unit })); }} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div><Label>Costing method</Label><Select value={f.costing_method} disabled={!isOwner} onChange={(e) => setF((s) => ({ ...s, costing_method: e.target.value as "WEIGHTED_AVERAGE" | "FIFO" }))}><option value="WEIGHTED_AVERAGE">Weighted Average</option><option value="FIFO">FIFO</option></Select></div>
            <div><Label>Default low-stock threshold</Label><Input type="number" value={f.low_stock_default} disabled={!isOwner} onChange={(e) => setF((s) => ({ ...s, low_stock_default: Number(e.target.value) }))} /></div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><Label>Barcode / label format</Label><Select value={f.barcode_format} disabled={!isOwner} onChange={(e) => setF((s) => ({ ...s, barcode_format: e.target.value }))}><option value="EAN">EAN-13</option><option value="UPC">UPC</option><option value="INTERNAL">Internal</option><option value="WEIGHT_EMBEDDED">Weight-embedded</option></Select></div>
            <div><Label>Default unit</Label><Input value={f.default_unit} disabled={!isOwner} onChange={(e) => setF((s) => ({ ...s, default_unit: e.target.value }))} /></div>
          </div>
          {isOwner ? <Button type="submit" disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin" />} Save inventory settings</Button> : <OwnerNote isOwner={isOwner} />}
        </form>
      </CardBody>
    </Card>
  );
}

/* ---------------- Sales ---------------- */
function SalesSection({ data, isOwner }: { data: SettingsData; isOwner: boolean }) {
  const { saving, run } = useSaver();
  const [f, setF] = useState(data);
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Receipt className="h-4 w-4" /> Sales settings</CardTitle></CardHeader>
      <CardBody>
        <form onSubmit={(e) => { e.preventDefault(); run(() => updateSalesSettings({ tax_percent: Number(f.tax_percent) || 0, rounding: f.rounding, receipt_template: f.receipt_template, allow_discounts: f.allow_discounts, return_window_days: Number(f.return_window_days) || 0 })); }} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div><Label>Tax (%)</Label><Input type="number" value={f.tax_percent} disabled={!isOwner} onChange={(e) => setF((s) => ({ ...s, tax_percent: Number(e.target.value) }))} /></div>
            <div><Label>Rounding</Label><Select value={f.rounding} disabled={!isOwner} onChange={(e) => setF((s) => ({ ...s, rounding: e.target.value }))}><option value="none">None</option><option value="nearest_1">Nearest ₨1</option><option value="nearest_5">Nearest ₨5</option></Select></div>
            <div><Label>Receipt template</Label><Select value={f.receipt_template} disabled={!isOwner} onChange={(e) => setF((s) => ({ ...s, receipt_template: e.target.value }))}><option value="standard">Standard</option><option value="compact">Compact</option></Select></div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label>Return window (days)</Label>
              <Input type="number" min={0} value={f.return_window_days} disabled={!isOwner}
                onChange={(e) => setF((s) => ({ ...s, return_window_days: Number(e.target.value) }))} />
              <p className="mt-1 text-xs text-text-tertiary">
                A sale stays returnable for this many days. 0 = no time limit.
              </p>
            </div>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-text-secondary">
            <input type="checkbox" checked={f.allow_discounts} disabled={!isOwner} onChange={(e) => setF((s) => ({ ...s, allow_discounts: e.target.checked }))} className="h-4 w-4 rounded border-border" /> Allow discounts at POS
          </label>
          {isOwner ? <Button type="submit" disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin" />} Save sales settings</Button> : <OwnerNote isOwner={isOwner} />}
        </form>
      </CardBody>
    </Card>
  );
}

/* ---------------- Integrations ---------------- */
function IntegrationsSection({ data, isOwner }: { data: SettingsData; isOwner: boolean }) {
  const { saving, run } = useSaver();
  const [f, setF] = useState({
    postex: data.courier.postex ?? "", leopards: data.courier.leopards ?? "", trax: data.courier.trax ?? "",
    resend: data.resend_key, whatsapp: data.whatsapp_key, from_email: data.from_email,
    stripe_secret: data.courier.stripe_secret ?? "",
    jazzcash_merchant: data.courier.jazzcash_merchant ?? "", jazzcash_password: data.courier.jazzcash_password ?? "",
    jazzcash_salt: data.courier.jazzcash_salt ?? "", jazzcash_sandbox: data.courier.jazzcash_sandbox === "true",
    easypaisa_store: data.courier.easypaisa_store ?? "", easypaisa_key: data.courier.easypaisa_key ?? "",
    easypaisa_sandbox: data.courier.easypaisa_sandbox === "true",
    notify_low_stock: Boolean((data.notif_prefs.low_stock as boolean) ?? true),
    notify_new_order: Boolean((data.notif_prefs.new_order as boolean) ?? true),
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));
  const jazzcashLive = Boolean(f.jazzcash_merchant && f.jazzcash_password && f.jazzcash_salt);
  const easypaisaLive = Boolean(f.easypaisa_store && f.easypaisa_key);
  const gatewayLive = jazzcashLive || easypaisaLive;
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Plug className="h-4 w-4" /> Integrations</CardTitle></CardHeader>
      <CardBody>
        <form onSubmit={(e) => { e.preventDefault(); run(() => updateIntegrations({
          courier: { postex: f.postex, leopards: f.leopards, trax: f.trax },
          resend_key: f.resend, whatsapp_key: f.whatsapp, from_email: f.from_email,
          payment: { stripe_secret: f.stripe_secret, jazzcash_merchant: f.jazzcash_merchant, jazzcash_password: f.jazzcash_password, jazzcash_salt: f.jazzcash_salt, jazzcash_sandbox: f.jazzcash_sandbox, easypaisa_store: f.easypaisa_store, easypaisa_key: f.easypaisa_key, easypaisa_sandbox: f.easypaisa_sandbox },
          notif_prefs: { low_stock: f.notify_low_stock, new_order: f.notify_new_order },
        })); }} className="space-y-4">
          <p className="text-xs font-medium text-text-secondary">Notifications</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div><Label>Resend (email) key</Label><Input value={f.resend} disabled={!isOwner} onChange={set("resend")} placeholder="re_..." /></div>
            <div><Label>Sender email</Label><Input value={f.from_email} disabled={!isOwner} onChange={set("from_email")} placeholder="orders@yourstore.pk" /></div>
            <div><Label>WhatsApp key</Label><Input value={f.whatsapp} disabled={!isOwner} onChange={set("whatsapp")} /></div>
          </div>

          <div className="flex items-center gap-2 border-t border-border pt-3">
            <p className="text-xs font-medium text-text-secondary">Online payments</p>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${gatewayLive ? "bg-green-tile text-green-text" : "bg-amber-tile text-amber-text"}`}>
              {gatewayLive ? "Live" : "Sandbox"}
            </span>
          </div>
          <p className="text-[11px] text-text-tertiary">JazzCash and Easypaisa are wired for live checkout — fill a provider’s fields to enable it (both can be on; the customer chooses). Leave blank for sandbox (no real charge). Set <span className="font-mono">NEXT_PUBLIC_APP_URL</span> so providers can return to your site.</p>

          <div className="flex items-center gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">JazzCash</p>
            <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${jazzcashLive ? "bg-green-tile text-green-text" : "bg-surface-2 text-text-tertiary"}`}>{jazzcashLive ? "On" : "Off"}</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div><Label>JazzCash merchant ID</Label><Input value={f.jazzcash_merchant} disabled={!isOwner} onChange={set("jazzcash_merchant")} /></div>
            <div><Label>JazzCash password</Label><Input value={f.jazzcash_password} disabled={!isOwner} onChange={set("jazzcash_password")} /></div>
            <div><Label>JazzCash integrity salt</Label><Input value={f.jazzcash_salt} disabled={!isOwner} onChange={set("jazzcash_salt")} /></div>
          </div>
          <label className="flex items-center gap-2 text-sm text-text-secondary"><input type="checkbox" checked={f.jazzcash_sandbox} disabled={!isOwner} onChange={(e) => setF((s) => ({ ...s, jazzcash_sandbox: e.target.checked }))} className="h-4 w-4 rounded border-border" /> Use JazzCash sandbox endpoint (for testing)</label>

          <div className="flex items-center gap-2 pt-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Easypaisa</p>
            <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${easypaisaLive ? "bg-green-tile text-green-text" : "bg-surface-2 text-text-tertiary"}`}>{easypaisaLive ? "On" : "Off"}</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><Label>Easypaisa store ID</Label><Input value={f.easypaisa_store} disabled={!isOwner} onChange={set("easypaisa_store")} /></div>
            <div><Label>Easypaisa hash key (16 chars)</Label><Input value={f.easypaisa_key} disabled={!isOwner} onChange={set("easypaisa_key")} /></div>
          </div>
          <label className="flex items-center gap-2 text-sm text-text-secondary"><input type="checkbox" checked={f.easypaisa_sandbox} disabled={!isOwner} onChange={(e) => setF((s) => ({ ...s, easypaisa_sandbox: e.target.checked }))} className="h-4 w-4 rounded border-border" /> Use Easypaisa staging endpoint (for testing)</label>

          <p className="text-[11px] text-text-tertiary">Stripe (stored for later — not yet wired for live checkout):</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div><Label>Stripe secret key</Label><Input value={f.stripe_secret} disabled={!isOwner} onChange={set("stripe_secret")} placeholder="sk_live_..." /></div>
          </div>

          <p className="border-t border-border pt-3 text-xs font-medium text-text-secondary">Courier API keys</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div><Label>PostEx</Label><Input value={f.postex} disabled={!isOwner} onChange={set("postex")} /></div>
            <div><Label>Leopards</Label><Input value={f.leopards} disabled={!isOwner} onChange={set("leopards")} /></div>
            <div><Label>Trax</Label><Input value={f.trax} disabled={!isOwner} onChange={set("trax")} /></div>
          </div>
          <p className="text-xs font-medium text-text-secondary">Notify admins when</p>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-text-secondary"><input type="checkbox" checked={f.notify_low_stock} disabled={!isOwner} onChange={(e) => setF((s) => ({ ...s, notify_low_stock: e.target.checked }))} className="h-4 w-4 rounded border-border" /> Stock falls below reorder point</label>
            <label className="flex items-center gap-2 text-sm text-text-secondary"><input type="checkbox" checked={f.notify_new_order} disabled={!isOwner} onChange={(e) => setF((s) => ({ ...s, notify_new_order: e.target.checked }))} className="h-4 w-4 rounded border-border" /> A new online order arrives</label>
          </div>
          {isOwner ? <Button type="submit" disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin" />} Save integrations</Button> : <OwnerNote isOwner={isOwner} />}
        </form>
      </CardBody>
    </Card>
  );
}

/* ---------------- Appearance ---------------- */
function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  return (
    <Card className="max-w-md">
      <CardHeader><CardTitle className="flex items-center gap-2"><Palette className="h-4 w-4" /> Appearance</CardTitle></CardHeader>
      <CardBody>
        <Label>Theme</Label>
        <div className="mt-2 grid grid-cols-2 gap-3">
          {(["light", "dark"] as const).map((t) => (
            <button key={t} onClick={() => setTheme(t)}
              className={cn("flex items-center gap-2 rounded-xl border-2 px-4 py-3 text-sm font-medium capitalize transition-colors",
                theme === t ? "border-brand-500 bg-brand-50/40 text-text-primary" : "border-border text-text-secondary hover:bg-surface-2")}>
              {t === "light" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />} {t}
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs text-text-tertiary">Saved on this device.</p>
      </CardBody>
    </Card>
  );
}

/* ---------------- Data (import / export) ---------------- */
function DataSection({ isOwner }: { isOwner: boolean }) {
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function doExport() {
    setBusy(true);
    const res = await exportProductsCSV();
    setBusy(false);
    if ("error" in res) { toast(res.error, "error"); return; }
    const blob = new Blob([res.csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "products-backup.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) { toast("CSV looks empty", "error"); return; }
    const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const idx = (name: string) => header.indexOf(name);
    const rows = lines.slice(1).map((ln) => {
      const c = ln.split(",");
      return {
        name: c[idx("name")]?.trim() ?? "", sku: c[idx("sku")]?.trim() ?? "",
        barcode: idx("barcode") >= 0 ? c[idx("barcode")]?.trim() : "",
        price: Number(c[idx("price")] ?? c[idx("sale_price")] ?? 0) || 0,
        cost: Number(c[idx("cost")] ?? 0) || 0, qty: Number(c[idx("qty")] ?? c[idx("on_hand")] ?? 0) || 0,
      };
    }).filter((r) => r.name && r.sku);
    setBusy(true);
    const res = await importProductsCSV(rows);
    setBusy(false);
    e.target.value = "";
    if ("error" in res && res.error) { toast(res.error, "error"); return; }
    toast(`Imported ${res.created} products${res.errors?.length ? `, ${res.errors.length} skipped` : ""}`);
    router.refresh();
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Download className="h-4 w-4" /> Export / backup</CardTitle></CardHeader>
        <CardBody>
          <p className="mb-3 text-sm text-text-secondary">Download all products, SKUs, barcodes, costs, prices and on-hand quantities as a CSV.</p>
          <Button variant="secondary" disabled={busy || !isOwner} onClick={doExport}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Export products CSV</Button>
        </CardBody>
      </Card>
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Upload className="h-4 w-4" /> Import products</CardTitle></CardHeader>
        <CardBody>
          <p className="mb-3 text-sm text-text-secondary">Upload a CSV with columns <code className="rounded bg-surface-2 px-1">name, sku, barcode, cost, price, qty</code>. Each row creates a product with opening stock.</p>
          <label className={cn("inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-surface-2 px-4 py-2 text-sm font-medium", (!isOwner || busy) && "pointer-events-none opacity-50")}>
            <Upload className="h-4 w-4" /> Choose CSV
            <input type="file" accept=".csv" className="hidden" onChange={onFile} disabled={!isOwner || busy} />
          </label>
        </CardBody>
      </Card>
    </div>
  );
}
