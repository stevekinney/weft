export type CronField = {
  values: number[];
  wildcard: boolean;
};

export type ParsedCronExpression = {
  expression: string;
  hasSeconds: boolean;
  seconds: CronField;
  minutes: CronField;
  hours: CronField;
  daysOfMonth: CronField;
  months: CronField;
  daysOfWeek: CronField;
};

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: number;
};

export type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export type CronOccurrenceOptions = {
  timeZone?: string;
  maxOccurrences?: number;
};
