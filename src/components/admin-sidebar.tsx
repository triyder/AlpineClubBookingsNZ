"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import {
  LayoutDashboard,
  Users,
  ArrowRightLeft,
  BookOpen,
  Clock,
  Tag,
  ClipboardCheck,
  ClipboardList,
  XCircle,
  BarChart2,
  RefreshCw,
  Menu,
  Mountain,
  CreditCard,
  FileText,
  Shield,
  Activity,
  Mail,
  UserCheck,
  Trash2,
  Sliders,
  House,
  Tablet,
  Tv,
  UsersRound,
  Bell,
  Bug,
  AlertTriangle,
  RotateCcw,
  ListChecks,
  Puzzle,
  UserX,
  BedDouble,
  Hammer,
  Palette,
  UserPlus,
  Plug,
  ChevronRight,
  Landmark,
  BadgeCheck,
  Building2,
  DollarSign,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { isFeatureHrefVisible } from "@/config/feature-routes";
import type { FeatureFlags } from "@/config/schema";
import {
  canViewAdminHrefWithMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";
import { formatDateOnly, getTodayDateOnly } from "@/lib/date-only";
import {
  buildUnpaidFinishedStaysHref,
  buildUnsettledAdditionalFinishedStaysHref,
} from "@/lib/unpaid-finished-stays";

interface NavSection {
  label?: string;
  items: Array<{
    href: string;
    label: string;
    icon: typeof LayoutDashboard;
    /** Shown only to Full Admins (e.g. access-role management). */
    fullAdminOnly?: boolean;
  }>;
}

/**
 * Label of the queue-driven section whose items are shown only when they have
 * something pending. The section (and its header) disappears entirely once all
 * its queues are clear, so it never implies work that isn't there.
 */
const NEEDS_ATTENTION_LABEL = "Needs Attention";

/**
 * localStorage key holding the admin's per-section expand/collapse state, as a
 * `{ [sectionLabel]: boolean }` map. Sections default to expanded; a label the
 * user has collapsed is persisted as `false`.
 */
const SIDEBAR_COLLAPSE_STORAGE_KEY = "admin-sidebar:expanded-sections";

/**
 * Deep link for the unpaid-finished-stays queue (#1731), shared with the
 * dashboard attention card via src/lib/unpaid-finished-stays.ts. Evaluated at
 * page load — the same moment the badge counts are fetched — so the link's
 * check-out cutoff and the fetched count describe the same NZ day.
 */
const UNPAID_FINISHED_STAYS_HREF = buildUnpaidFinishedStaysHref(
  formatDateOnly(getTodayDateOnly()),
);

/**
 * Deep link for the unsettled finished-stay additions queue (#1723 path 2):
 * settled past stays whose upward modification delta was never collected.
 * Same evaluation moment and drift rule as the queue above.
 */
const UNSETTLED_ADDITIONS_HREF = buildUnsettledAdditionalFinishedStaysHref(
  formatDateOnly(getTodayDateOnly()),
);

const navSections: NavSection[] = [
  {
    items: [
      {
        href: "/admin/dashboard",
        label: "Admin Dashboard",
        icon: LayoutDashboard,
      },
    ],
  },
  {
    // Queue-driven alerts. Every item here is also reachable from its natural
    // section below (Unpaid Finished Stays as a pre-filtered Bookings view);
    // these are duplicate links that surface only while their queue has
    // something pending (see the filtering in SidebarLinks).
    label: NEEDS_ATTENTION_LABEL,
    items: [
      {
        href: "/admin/booking-requests",
        label: "Booking Requests",
        icon: ClipboardList,
      },
      {
        href: UNPAID_FINISHED_STAYS_HREF,
        label: "Unpaid Finished Stays",
        icon: DollarSign,
      },
      {
        href: UNSETTLED_ADDITIONS_HREF,
        label: "Unpaid Stay Additions",
        icon: DollarSign,
      },
      {
        href: "/admin/member-applications",
        label: "Applications",
        icon: ClipboardList,
      },
      { href: "/admin/family-groups", label: "Family Groups", icon: Users },
      {
        href: "/admin/refund-requests",
        label: "Refunds & Credits",
        icon: RotateCcw,
      },
      {
        href: "/admin/membership-cancellations",
        label: "Cancellation Requests",
        icon: UserX,
      },
      {
        href: "/admin/deletion-requests",
        label: "Deletion Requests",
        icon: Trash2,
      },
      { href: "/admin/issue-reports", label: "Issue Reports", icon: Bug },
      { href: "/admin/hut-leaders", label: "Hut Leaders", icon: Bell },
    ],
  },
  {
    label: "Bookings & Beds",
    items: [
      { href: "/admin/bookings", label: "Bookings", icon: BookOpen },
      {
        href: "/admin/booking-requests",
        label: "Booking Requests",
        icon: ClipboardList,
      },
      { href: "/admin/book", label: "Book on Behalf", icon: UserPlus },
      {
        href: "/admin/bed-allocation",
        label: "Bed Allocation",
        icon: BedDouble,
      },
      { href: "/admin/waitlist", label: "Waitlist", icon: Clock },
    ],
  },
  {
    label: "Rates & Policies",
    items: [
      // Hut Fees & Seasons is lodge-scoped (#130, ADR-005) — reached via the
      // lodge hub's "Seasons & Rates" card (/admin/lodges/[id]), not a standalone
      // sidebar entry.
      { href: "/admin/age-tier-settings", label: "Age Groups", icon: Sliders },
      { href: "/admin/promo-codes", label: "Promo Codes", icon: Tag },
      {
        href: "/admin/booking-policies",
        label: "Booking Policies",
        icon: XCircle,
      },
    ],
  },
  {
    label: "Finance",
    items: [
      { href: "/admin/payments", label: "Payments", icon: CreditCard },
      {
        href: "/admin/internet-banking",
        label: "Internet Banking",
        icon: Landmark,
      },
      {
        href: "/admin/refund-requests",
        label: "Refunds & Credits",
        icon: RotateCcw,
      },
      { href: "/admin/reports", label: "Reports", icon: BarChart2 },
      { href: "/admin/xero", label: "Xero Sync", icon: RefreshCw },
    ],
  },
  {
    label: "Members",
    items: [
      { href: "/admin/members", label: "Members", icon: Users },
      { href: "/admin/subscriptions", label: "Subscriptions", icon: FileText },
      {
        href: "/admin/member-applications",
        label: "Applications",
        icon: ClipboardList,
      },
      {
        href: "/admin/membership-cancellations",
        label: "Cancellation Requests",
        icon: UserX,
      },
      { href: "/admin/induction", label: "Induction", icon: ClipboardCheck },
      { href: "/admin/communications", label: "Communications", icon: Mail },
      // Lockers is lodge-scoped (#130, ADR-005) — reached via the lodge hub's
      // "Lockers" card, not a standalone sidebar entry.
      { href: "/admin/family-groups", label: "Family Groups", icon: Users },
      {
        href: "/admin/family-suggestions",
        label: "Family Suggestions",
        icon: Users,
      },
    ],
  },
  {
    label: "Lodge Operations",
    items: [
      { href: "/admin/hut-leaders", label: "Hut Leaders", icon: UserCheck },
      { href: "/admin/roster", label: "Roster", icon: ClipboardList },
      { href: "/admin/lodge", label: "Lodge Kiosk", icon: Tablet },
      { href: "/admin/work-parties", label: "Work Parties", icon: Hammer },
      {
        href: "/admin/lodge-instructions",
        label: "Lodge Instructions",
        icon: BookOpen,
      },
    ],
  },
  {
    // Lobby Display (fork issue #109): one sidebar entry opens the hub landing
    // page (/admin/display), which lays out cards for Devices, Layouts,
    // Templates, and Reference — mirroring the "Site Appearance & Content" hub
    // rather than scattering four items through the sidebar. The Devices
    // management page moved to /admin/display/devices; /admin/display/settings
    // redirects there. Per-lodge display config (glob, name granularity,
    // committee notice) lives on each lodge in the lodge configuration hub
    // (/admin/lodges/[id]) since LTV-035/#81.
    items: [{ href: "/admin/display", label: "Lobby Display", icon: Tv }],
  },
  {
    label: "Monitoring & Support",
    items: [
      { href: "/admin/issue-reports", label: "Issue Reports", icon: Bug },
      {
        href: "/admin/stuck-states",
        label: "Stuck States",
        icon: AlertTriangle,
      },
      { href: "/admin/health", label: "System Health", icon: Activity },
      {
        href: "/admin/email-deliverability",
        label: "Email Deliverability",
        icon: Mail,
      },
      { href: "/admin/background-jobs", label: "Background Jobs", icon: Clock },
      { href: "/admin/audit-log", label: "Audit Log", icon: Shield },
      {
        href: "/admin/deletion-requests",
        label: "Deletion Requests",
        icon: Trash2,
      },
    ],
  },
  {
    label: "Setup & Configuration",
    items: [
      { href: "/admin/setup", label: "Setup", icon: ListChecks },
      { href: "/admin/modules", label: "Modules", icon: Puzzle },
      { href: "/admin/lodges", label: "Lodges", icon: Building2 },
      {
        href: "/admin/membership-setup",
        label: "Membership & Members",
        icon: BadgeCheck,
      },
      {
        href: "/admin/appearance",
        label: "Site Appearance & Content",
        icon: Palette,
      },
      {
        href: "/admin/bookings-setup",
        label: "Bookings Setup",
        icon: BedDouble,
      },
      { href: "/admin/integrations", label: "Integrations", icon: Plug },
      {
        href: "/admin/notifications",
        label: "Notifications & Email",
        icon: Bell,
      },
      // Chores is lodge-scoped (#130, ADR-005) — reached via the lodge hub's
      // "Chores" card, not a standalone sidebar entry.
      {
        href: "/admin/access-roles",
        label: "Access Roles",
        icon: Shield,
        fullAdminOnly: true,
      },
      {
        href: "/admin/config-transfer",
        label: "Export & Import",
        icon: ArrowRightLeft,
        fullAdminOnly: true,
      },
      { href: "/admin/committee", label: "Committee", icon: UsersRound },
    ],
  },
];

// test seam
export function getVisibleAdminNavSections(
  features: FeatureFlags,
  permissionMatrix?: AdminPermissionMatrix,
  isFullAdmin?: boolean,
  hutLeaderLabel = "Hut Leader",
): NavSection[] {
  return navSections
    .map((section) => ({
      ...section,
      items: section.items
        .filter(
          (item) =>
            isFeatureHrefVisible(item.href, features) &&
            (!item.fullAdminOnly || isFullAdmin) &&
            (!permissionMatrix ||
              canViewAdminHrefWithMatrix(permissionMatrix, item.href)),
        )
        .map((item) =>
          item.href === "/admin/hut-leaders"
            ? { ...item, label: `${hutLeaderLabel}s` }
            : item,
        ),
    }))
    .filter((section) => section.items.length > 0);
}

type AdminNavBadgeMap = Record<string, number>;

// test seam
export function getRenderedAdminNavSections(
  features: FeatureFlags,
  badges: AdminNavBadgeMap,
  permissionMatrix?: AdminPermissionMatrix,
  isFullAdmin?: boolean,
  hutLeaderLabel = "Hut Leader",
): NavSection[] {
  return getVisibleAdminNavSections(
    features,
    permissionMatrix,
    isFullAdmin,
    hutLeaderLabel,
  )
    .map((section) =>
      section.label === NEEDS_ATTENTION_LABEL
        ? {
            ...section,
            items: section.items.filter((item) => (badges[item.href] ?? 0) > 0),
          }
        : section,
    )
    .filter((section) => section.items.length > 0);
}

import type { AdminPendingCounts } from "@/lib/admin-pending-counts";

const ZERO_PENDING_COUNTS: AdminPendingCounts = {
  familyRequests: 0,
  memberApplications: 0,
  refundAppeals: 0,
  creditApprovals: 0,
  bookingReviews: 0,
  bookingChangeRequests: 0,
  publicBookingRequests: 0,
  unpaidFinishedStays: 0,
  unsettledAdditionalFinishedStays: 0,
  membershipCancellations: 0,
  archiveRequests: 0,
  deletionRequests: 0,
  issueReports: 0,
  unassignedHutLeaderDates: 0,
};

/** Fetch every queue count for the sidebar badges in a single request. */
function usePendingCounts(): AdminPendingCounts {
  const [counts, setCounts] = useState<AdminPendingCounts>(ZERO_PENDING_COUNTS);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/admin/pending-counts")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled && data) {
          setCounts({ ...ZERO_PENDING_COUNTS, ...data });
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  return counts;
}

function SidebarLinks({
  features,
  permissionMatrix,
  isFullAdmin,
  hutLeaderLabel = "Hut Leader",
  onNavigate,
}: {
  features: FeatureFlags;
  permissionMatrix?: AdminPermissionMatrix;
  isFullAdmin?: boolean;
  hutLeaderLabel?: string;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const counts = usePendingCounts();

  // Per-section expand state, keyed by label. Starts as an empty map (every
  // section open) so server and first client render match; the stored
  // preference is applied after mount. "Needs Attention" is never collapsible.
  const [expandedSections, setExpandedSections] = useState<
    Record<string, boolean>
  >({});

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SIDEBAR_COLLAPSE_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object") {
          setExpandedSections(parsed as Record<string, boolean>);
        }
      }
    } catch {
      // Unavailable or malformed storage; fall back to all expanded.
    }
  }, []);

  const toggleSection = (label: string) => {
    setExpandedSections((prev) => {
      // An absent entry means "open by default", so negate the effective state.
      const next = { ...prev, [label]: !(prev[label] ?? true) };
      try {
        window.localStorage.setItem(
          SIDEBAR_COLLAPSE_STORAGE_KEY,
          JSON.stringify(next),
        );
      } catch {
        // Storage unavailable; state still updates for this session.
      }
      return next;
    });
  };

  // Map href -> badge count
  const badges: Record<string, number> = {};
  if (counts.memberApplications > 0) {
    badges["/admin/member-applications"] = counts.memberApplications;
  }
  if (counts.familyRequests > 0) {
    badges["/admin/family-groups"] = counts.familyRequests;
  }
  const bookingRequestCount =
    counts.bookingReviews +
    counts.bookingChangeRequests +
    counts.publicBookingRequests;
  if (bookingRequestCount > 0) {
    badges["/admin/booking-requests"] = bookingRequestCount;
  }
  if (counts.unpaidFinishedStays > 0) {
    badges[UNPAID_FINISHED_STAYS_HREF] = counts.unpaidFinishedStays;
  }
  if (counts.unsettledAdditionalFinishedStays > 0) {
    badges[UNSETTLED_ADDITIONS_HREF] = counts.unsettledAdditionalFinishedStays;
  }
  if (counts.refundAppeals + counts.creditApprovals > 0) {
    badges["/admin/refund-requests"] =
      counts.refundAppeals + counts.creditApprovals;
  }
  if (counts.membershipCancellations + counts.archiveRequests > 0) {
    badges["/admin/membership-cancellations"] =
      counts.membershipCancellations + counts.archiveRequests;
  }
  if (counts.deletionRequests > 0) {
    badges["/admin/deletion-requests"] = counts.deletionRequests;
  }
  if (counts.issueReports > 0) {
    badges["/admin/issue-reports"] = counts.issueReports;
  }
  if (counts.unassignedHutLeaderDates > 0) {
    badges["/admin/hut-leaders"] = counts.unassignedHutLeaderDates;
  }

  const renderedNavSections = getRenderedAdminNavSections(
    features,
    badges,
    permissionMatrix,
    isFullAdmin,
    hutLeaderLabel,
  );
  const visibleNavSections = getVisibleAdminNavSections(
    features,
    permissionMatrix,
    isFullAdmin,
    hutLeaderLabel,
  );

  // Highlight the most specific nav item whose href is a prefix of the current
  // path, so nested routes (e.g. /admin/xero/setup) activate the deepest match
  // rather than every ancestor (e.g. both "Xero Sync" and "Xero Setup").
  const activeHref = visibleNavSections
    .flatMap((section) => section.items.map((item) => item.href))
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .reduce((best, href) => (href.length > best.length ? href : best), "");

  return (
    <nav aria-label="Admin sections" className="flex flex-col gap-0.5">
      <Link
        href="/dashboard"
        onClick={onNavigate}
        className="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <House className="h-4 w-4 shrink-0 text-muted-foreground" />
        Member Dashboard
      </Link>
      <div className="my-1.5 border-t border-border" />
      {renderedNavSections.map((section, sIdx) => {
        // Every labeled section collapses except "Needs Attention"; the
        // label-less top section (Admin Dashboard) is always shown.
        const collapsible =
          Boolean(section.label) && section.label !== NEEDS_ATTENTION_LABEL;
        const open =
          !collapsible || (expandedSections[section.label as string] ?? true);

        return (
          <div key={sIdx}>
            {section.label &&
              (collapsible ? (
                <button
                  type="button"
                  onClick={() => toggleSection(section.label as string)}
                  aria-expanded={open}
                  className="flex w-full items-center gap-1 rounded-md px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ChevronRight
                    className={cn(
                      "h-3 w-3 shrink-0 transition-transform",
                      open && "rotate-90",
                    )}
                  />
                  <span>{section.label}</span>
                </button>
              ) : (
                <p className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {section.label}
                </p>
              ))}
            {open &&
              section.items.map(({ href, label, icon: Icon }) => {
                const active = href === activeHref;
                const badgeCount = badges[href];
                const badgeClasses =
                  href === "/admin/refund-requests"
                    ? "bg-red-600 text-white"
                    : "bg-orange-500 text-white";

                return (
                  <Link
                    key={href}
                    href={href}
                    onClick={onNavigate}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                      active
                        ? "app-nav-link-active"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    <Icon
                      className={cn(
                        "h-4 w-4 shrink-0",
                        active ? "text-current" : "text-muted-foreground",
                      )}
                    />
                    <span className="flex-1">{label}</span>
                    {badgeCount != null && badgeCount > 0 && (
                      <span
                        className={cn(
                          "ml-auto inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold",
                          badgeClasses,
                        )}
                      >
                        {badgeCount > 99 ? "99+" : badgeCount}
                      </span>
                    )}
                  </Link>
                );
              })}
          </div>
        );
      })}
    </nav>
  );
}

export function AdminSidebar({
  features,
  permissionMatrix,
  isFullAdmin,
  hutLeaderLabel = "Hut Leader",
}: {
  features: FeatureFlags;
  permissionMatrix?: AdminPermissionMatrix;
  isFullAdmin?: boolean;
  hutLeaderLabel?: string;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-background print:hidden md:sticky md:top-16 md:flex md:h-[calc(100vh-4rem)]">
        <div className="flex h-16 shrink-0 items-center gap-2 border-b px-4 font-bold text-foreground">
          <span className="app-brand-mark h-9 w-9">
            <Mountain className="h-5 w-5" />
          </span>
          <span>Admin Panel</span>
        </div>
        <div className="flex-1 overflow-y-auto p-3 pb-8">
          <SidebarLinks
            features={features}
            permissionMatrix={permissionMatrix}
            isFullAdmin={isFullAdmin}
            hutLeaderLabel={hutLeaderLabel}
          />
        </div>
      </aside>

      {/* Mobile header bar with toggle */}
      <div className="flex h-14 items-center gap-3 border-b bg-background px-4 print:hidden md:hidden">
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open admin menu">
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="flex w-64 flex-col p-0">
            <SheetHeader className="flex h-16 shrink-0 flex-row items-center gap-2 border-b px-4">
              <span className="app-brand-mark h-9 w-9">
                <Mountain className="h-5 w-5" />
              </span>
              <SheetTitle>Admin Panel</SheetTitle>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto p-3 pb-8">
              <SidebarLinks
                features={features}
                permissionMatrix={permissionMatrix}
                isFullAdmin={isFullAdmin}
                hutLeaderLabel={hutLeaderLabel}
                onNavigate={() => setMobileOpen(false)}
              />
            </div>
          </SheetContent>
        </Sheet>
        <span className="font-semibold text-foreground">Admin Panel</span>
      </div>
    </>
  );
}
