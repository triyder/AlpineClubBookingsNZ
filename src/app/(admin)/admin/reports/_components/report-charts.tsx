"use client";

/**
 * Recharts trees for the admin reports page, extracted verbatim (#1147) so the
 * ~139kB gz recharts chunk loads on demand via next/dynamic instead of inside
 * the route's First Load JS. Rendering, formatters, and colours are unchanged.
 */

import { format } from "date-fns";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import type { RevenueGranularity } from "@/lib/admin-reports";
import { formatCents } from "@/lib/utils";
import { bookingStatusLabel } from "@/lib/status-colors";

const PIE_COLORS = ["#3b82f6", "#ef4444"];
const STATUS_COLORS = ["#22c55e", "#3b82f6", "#8b5cf6", "#f59e0b", "#ef4444", "#f97316"];

export function OccupancyAreaChart({
  data,
}: {
  data: Array<{ date: string; occupancyRate: number }>;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 12 }}
          tickFormatter={(date) => format(new Date(date + "T00:00:00"), "MMM d")}
        />
        <YAxis
          domain={[0, 100]}
          tick={{ fontSize: 12 }}
          tickFormatter={(value) => `${value}%`}
        />
        <Tooltip
          formatter={(value) => [`${value}%`, "Occupancy"]}
          labelFormatter={(date) =>
            format(new Date(date + "T00:00:00"), "EEE, MMM d yyyy")
          }
        />
        <Area
          type="monotone"
          dataKey="occupancyRate"
          stroke="#3b82f6"
          fill="#3b82f6"
          fillOpacity={0.2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function RevenueBarChart({
  data,
  granularity,
}: {
  data: Array<{ label: string; revenueCents: number; tooltipLabel?: string }>;
  granularity: RevenueGranularity;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 12 }}
          interval="preserveStartEnd"
          angle={granularity === "daily" ? -20 : 0}
          textAnchor={granularity === "daily" ? "end" : "middle"}
          height={granularity === "daily" ? 56 : 30}
        />
        <YAxis
          tick={{ fontSize: 12 }}
          tickFormatter={(value) => `$${(value / 100).toFixed(0)}`}
        />
        <Tooltip
          labelFormatter={(_value, payload) =>
            payload?.[0]?.payload?.tooltipLabel ?? ""
          }
          formatter={(value) => [formatCents(Number(value)), "Revenue"]}
        />
        <Bar dataKey="revenueCents" fill="#22c55e" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function TrendsLineChart({
  data,
}: {
  data: Array<{
    week: string;
    total: number;
    confirmed: number;
    cancelled: number;
  }>;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis
          dataKey="week"
          tick={{ fontSize: 12 }}
          tickFormatter={(week) =>
            format(new Date(week + "T00:00:00"), "MMM d")
          }
        />
        <YAxis tick={{ fontSize: 12 }} />
        <Tooltip
          labelFormatter={(week) =>
            `Week of ${format(new Date(week + "T00:00:00"), "MMM d, yyyy")}`
          }
        />
        <Legend />
        <Line
          type="monotone"
          dataKey="total"
          stroke="#3b82f6"
          strokeWidth={2}
          name="Total"
        />
        <Line
          type="monotone"
          dataKey="confirmed"
          stroke="#22c55e"
          strokeWidth={2}
          name={bookingStatusLabel("CONFIRMED")}
        />
        <Line
          type="monotone"
          dataKey="cancelled"
          stroke="#ef4444"
          strokeWidth={1}
          strokeDasharray="5 5"
          name="Cancelled"
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function MemberSplitPieChart({
  data,
}: {
  data: Array<{ name: string; value: number }>;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={50}
          outerRadius={80}
          paddingAngle={5}
          dataKey="value"
          label={({ name, percent }) =>
            `${name} (${((percent ?? 0) * 100).toFixed(0)}%)`
          }
        >
          {data.map((_, index) => (
            <Cell
              key={`member-split-${index}`}
              fill={PIE_COLORS[index % PIE_COLORS.length]}
            />
          ))}
        </Pie>
        <Tooltip />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function StatusPieChart({
  data,
}: {
  data: Array<{ name: string; value: number }>;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={50}
          outerRadius={80}
          paddingAngle={5}
          dataKey="value"
          label={({ name, value }) => `${name}: ${value}`}
        >
          {data.map((_, index) => (
            <Cell
              key={`status-split-${index}`}
              fill={STATUS_COLORS[index % STATUS_COLORS.length]}
            />
          ))}
        </Pie>
        <Tooltip />
        <Legend />
      </PieChart>
    </ResponsiveContainer>
  );
}
