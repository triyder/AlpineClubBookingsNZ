import { addDaysDateOnly, formatDateOnly, getTodayDateOnly } from "@/lib/date-only";

export const CUSTOM_DATE_RANGE_KEY = "custom";

export interface DateRangeValues {
  from: string;
  to: string;
}

export interface DateRangePreset {
  key: string;
  label: string;
  getRange: (today: Date) => DateRangeValues;
}

function dateOnly(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day));
}

function addMonthsDateOnly(date: Date, months: number): Date {
  const targetMonthStart = dateOnly(date.getUTCFullYear(), date.getUTCMonth() + months, 1);
  const lastDayOfTargetMonth = endOfMonthDateOnly(targetMonthStart).getUTCDate();
  return dateOnly(
    targetMonthStart.getUTCFullYear(),
    targetMonthStart.getUTCMonth(),
    Math.min(date.getUTCDate(), lastDayOfTargetMonth)
  );
}

function startOfMonthDateOnly(date: Date): Date {
  return dateOnly(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function endOfMonthDateOnly(date: Date): Date {
  return dateOnly(date.getUTCFullYear(), date.getUTCMonth() + 1, 0);
}

function startOfQuarterDateOnly(date: Date): Date {
  const quarterStartMonth = Math.floor(date.getUTCMonth() / 3) * 3;
  return dateOnly(date.getUTCFullYear(), quarterStartMonth, 1);
}

function endOfQuarterDateOnly(date: Date): Date {
  const quarterStartMonth = Math.floor(date.getUTCMonth() / 3) * 3;
  return dateOnly(date.getUTCFullYear(), quarterStartMonth + 3, 0);
}

function startOfYearDateOnly(date: Date): Date {
  return dateOnly(date.getUTCFullYear(), 0, 1);
}

function endOfYearDateOnly(date: Date): Date {
  return dateOnly(date.getUTCFullYear(), 11, 31);
}

function toInputDate(date: Date): string {
  return formatDateOnly(date);
}

function makeRange(from: Date, to: Date): DateRangeValues {
  return {
    from: toInputDate(from),
    to: toInputDate(to),
  };
}

const allDatesPreset: DateRangePreset = {
  key: "all_dates",
  label: "All Dates",
  getRange: () => ({ from: "", to: "" }),
};

const last7DaysPreset: DateRangePreset = {
  key: "last_7_days",
  label: "Last 7 Days",
  getRange: (today) => makeRange(addDaysDateOnly(today, -6), today),
};

const last30DaysPreset: DateRangePreset = {
  key: "last_30_days",
  label: "Last 30 Days",
  getRange: (today) => makeRange(addDaysDateOnly(today, -29), today),
};

const thisMonthPreset: DateRangePreset = {
  key: "this_month",
  label: "This Month",
  getRange: (today) => makeRange(startOfMonthDateOnly(today), endOfMonthDateOnly(today)),
};

const lastMonthPreset: DateRangePreset = {
  key: "last_month",
  label: "Last Month",
  getRange: (today) => {
    const lastMonth = addMonthsDateOnly(today, -1);
    return makeRange(startOfMonthDateOnly(lastMonth), endOfMonthDateOnly(lastMonth));
  },
};

const nextMonthPreset: DateRangePreset = {
  key: "next_month",
  label: "Next Month",
  getRange: (today) => {
    const nextMonth = addMonthsDateOnly(today, 1);
    return makeRange(startOfMonthDateOnly(nextMonth), endOfMonthDateOnly(nextMonth));
  },
};

const lastQuarterPreset: DateRangePreset = {
  key: "last_quarter",
  label: "Last Quarter",
  getRange: (today) => {
    const lastQuarter = addMonthsDateOnly(today, -3);
    return makeRange(startOfQuarterDateOnly(lastQuarter), endOfQuarterDateOnly(lastQuarter));
  },
};

const yearToDatePreset: DateRangePreset = {
  key: "year_to_date",
  label: "Year to Date",
  getRange: (today) => makeRange(startOfYearDateOnly(today), today),
};

const lastYearPreset: DateRangePreset = {
  key: "last_year",
  label: "Last Year",
  getRange: (today) => {
    const lastYear = dateOnly(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate());
    return makeRange(startOfYearDateOnly(lastYear), endOfYearDateOnly(lastYear));
  },
};

const next30DaysPreset: DateRangePreset = {
  key: "next_30_days",
  label: "Next 30 Days",
  getRange: (today) => makeRange(today, addDaysDateOnly(today, 29)),
};

const next90DaysPreset: DateRangePreset = {
  key: "next_90_days",
  label: "Next 90 Days",
  getRange: (today) => makeRange(today, addDaysDateOnly(today, 89)),
};

export const auditAndPaymentsDateRangePresets: readonly DateRangePreset[] = [
  allDatesPreset,
  last7DaysPreset,
  last30DaysPreset,
  thisMonthPreset,
  lastMonthPreset,
  lastQuarterPreset,
  yearToDatePreset,
  lastYearPreset,
];

export const bookingFilterDateRangePresets: readonly DateRangePreset[] = [
  allDatesPreset,
  thisMonthPreset,
  lastMonthPreset,
  nextMonthPreset,
  lastQuarterPreset,
  next30DaysPreset,
  next90DaysPreset,
  lastYearPreset,
];

export const reportsDateRangePresets: readonly DateRangePreset[] = [
  thisMonthPreset,
  lastMonthPreset,
  lastQuarterPreset,
  yearToDatePreset,
  lastYearPreset,
];

export function getDateRangeForPreset(
  preset: DateRangePreset,
  today = getTodayDateOnly()
): DateRangeValues {
  return preset.getRange(today);
}

export function findMatchingDateRangePreset(
  from: string,
  to: string,
  presets: readonly DateRangePreset[],
  today = getTodayDateOnly()
): string | null {
  const match = presets.find((preset) => {
    const range = getDateRangeForPreset(preset, today);
    return range.from === from && range.to === to;
  });

  return match?.key ?? null;
}
