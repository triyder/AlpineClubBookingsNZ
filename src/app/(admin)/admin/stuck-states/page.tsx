import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  BedDouble,
  CalendarCheck,
  CreditCard,
  Mail,
  RefreshCw,
  ShieldAlert,
  TentTree,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminDataTable } from "@/components/admin/admin-data-table";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { APP_LOCALE, APP_TIME_ZONE } from "@/config/operational";
import {
  getStuckStateDashboard,
  type StuckStateDomain,
  type StuckStateItem,
  type StuckStateSeverity,
} from "@/lib/stuck-state-dashboard";
import { cn } from "@/lib/utils";

const domainIcons: Record<StuckStateDomain, typeof CreditCard> = {
  payment: CreditCard,
  booking: CalendarCheck,
  xero: RefreshCw,
  email: Mail,
  waitlist: AlertTriangle,
  bed_allocation: BedDouble,
  lodge: TentTree,
};

const severityLabels: Record<StuckStateSeverity, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
};

function formatGeneratedAt(value: string) {
  return new Date(value).toLocaleString(APP_LOCALE, {
    timeZone: APP_TIME_ZONE,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function severityBadgeVariant(severity: StuckStateSeverity) {
  if (severity === "critical") return "destructive" as const;
  if (severity === "warning") return "warning" as const;
  return "secondary" as const;
}

function severityRing(severity: StuckStateSeverity | null) {
  if (severity === "critical") return "border-danger/30 bg-danger-muted";
  if (severity === "warning") return "border-warning/30 bg-warning-muted";
  if (severity === "info") return "border-info/30 bg-info-muted";
  return "border-border bg-card";
}

function SummaryCard({
  title,
  value,
  tone,
}: {
  title: string;
  value: number;
  tone: "critical" | "warning" | "info" | "neutral";
}) {
  const toneClasses = {
    critical: "border-danger/30 bg-danger-muted text-danger",
    warning: "border-warning/30 bg-warning-muted text-warning",
    info: "border-info/30 bg-info-muted text-info",
    neutral: "border-border bg-card text-card-foreground",
  };

  return (
    <Card className={toneClasses[tone]}>
      <CardContent className="pt-5">
        <div className="text-3xl font-bold">{value}</div>
        <div className="mt-1 text-sm font-medium">{title}</div>
      </CardContent>
    </Card>
  );
}

function ItemRow({ item }: { item: StuckStateItem }) {
  const Icon = domainIcons[item.domain];

  return (
    <TableRow className="align-top">
      <TableCell>
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium">{item.domainLabel}</span>
        </div>
      </TableCell>
      <TableCell>
        <div className="font-medium">{item.title}</div>
        <div className="mt-1 max-w-2xl text-sm text-muted-foreground">
          {item.summary}
        </div>
      </TableCell>
      <TableCell>
        <Badge variant={severityBadgeVariant(item.severity)}>
          {severityLabels[item.severity]}
        </Badge>
      </TableCell>
      <TableCell className="text-sm">{item.owner}</TableCell>
      <TableCell className="text-right text-sm font-semibold">
        {item.count}
      </TableCell>
      <TableCell className="text-right">
        <Button asChild variant="outline" size="sm">
          <Link href={item.href}>
            Open
            <ArrowRight className="ml-2 h-4 w-4" />
          </Link>
        </Button>
      </TableCell>
    </TableRow>
  );
}

export default async function AdminStuckStatesPage() {
  const dashboard = await getStuckStateDashboard();

  return (
    <div className="space-y-8">
      <AdminPageHeader
        title="Stuck States"
        description={`Generated ${formatGeneratedAt(dashboard.generatedAt)}`}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/health">System Health</Link>
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          title="Critical records"
          value={dashboard.totals.critical}
          tone="critical"
        />
        <SummaryCard
          title="Warning records"
          value={dashboard.totals.warning}
          tone="warning"
        />
        <SummaryCard
          title="Info records"
          value={dashboard.totals.info}
          tone="info"
        />
        <SummaryCard
          title="Open signals"
          value={dashboard.totals.itemCount}
          tone="neutral"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {dashboard.domains.map((domain) => {
          const Icon = domainIcons[domain.domain];
          return (
            <Card
              key={domain.domain}
              className={cn("border", severityRing(domain.highestSeverity))}
            >
              <CardContent className="flex items-center justify-between gap-4 pt-5">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-card text-foreground">
                    <Icon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">
                      {domain.label}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {domain.itemCount} signal{domain.itemCount === 1 ? "" : "s"}
                    </p>
                  </div>
                </div>
                <div className="text-right text-2xl font-bold text-foreground">
                  {domain.count}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <ShieldAlert className="h-5 w-5 text-muted-foreground" />
            Operator Queue
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {dashboard.items.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
              <ShieldAlert className="h-10 w-10 text-success" />
              <p className="text-sm font-medium text-muted-foreground">
                No stuck states found.
              </p>
            </div>
          ) : (
            <AdminDataTable className="min-w-[840px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Domain</TableHead>
                  <TableHead>Signal</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dashboard.items.map((item) => (
                  <ItemRow key={item.id} item={item} />
                ))}
              </TableBody>
            </AdminDataTable>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
