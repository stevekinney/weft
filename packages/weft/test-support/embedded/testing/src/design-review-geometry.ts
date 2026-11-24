export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
/** One control the page shows: a button, a link, a field, or another widget a person operates. */
export interface ControlFact {
  /** The tag and first class, with a Cinder size when it has one: `button.cinder-button[size=medium]`. */
  readonly name: string;
  readonly kind: 'button' | 'link' | 'field' | 'other';
  /** The visible label, collapsed and cut to sixty characters; empty for an icon-only control. */
  readonly text: string;
  /** The `aria-label` or `title`, which names an icon-only control. */
  readonly accessibleLabel: string;
  readonly hasIcon: boolean;
  /** Whether it is laid out inline in a sentence, which WCAG 2.5.8 exempts from the target size. */
  readonly inline: boolean;
  /**
   * Whether it is an action on a message's time-and-actions line. On a touch screen its tap area is
   * smaller than 44px and stays clear of all text (owner decision of 2026-11-15 on COR-2406), so
   * the touch minimum and the 22px probe do not apply to it; the WCAG 2.5.8 minimum does.
   */
  readonly lineAction?: boolean;
  /** The Cinder variant it is drawn in, or empty when it names none. */
  readonly variant: string;
  /**
   * The painted face: the border box less any border that draws nothing over a fill clipped inside
   * it. Every rule about what a person sees (size, padding) reads this.
   */
  readonly rect: Box;
  /** The box it takes in the layout, which is larger than `rect` when a transparent border pads it. */
  readonly layout: Box;
  /** The union of the visible text and icons inside, or `null` when it draws nothing of its own. */
  readonly content: Box | null;
  readonly fontSize: number;
  /** Whether a positioned pseudo-element extends the area that takes a tap beyond what is drawn. */
  readonly extendedHitArea: boolean;
  /**
   * The area that takes a tap: the control, any pseudo-element that extends it invisibly, and the
   * label around a checkbox or radio. The same as `rect` when nothing extends it.
   */
  readonly hit: Box;
  /**
   * On a touch screen, the sides on which a tap half the touch minimum from the center does not
   * reach the control, each with what it reaches instead. Empty when every side answers, and `null`
   * when the control was not asked: a mouse capture, a disabled control, one covered at its center,
   * or one with every probe point off screen.
   */
  readonly unreached: readonly string[] | null;
  /** A number shared by the controls of one parent, so controls in one row can be told apart. */
  readonly parent: number;
  /** Whether it fills its container's inline size and at least half the viewport. */
  readonly fullWidth: boolean;
  /** Whether it draws a box of its own, a border or a fill, so its padding is something a person sees. */
  readonly boxed: boolean;
  /** How many separate runs of text it holds: one for a label, more for a row that is a button. */
  readonly labelRuns: number;
}

/** One combination of size, line height and weight the page sets text in. */
export interface TextStyleFact {
  readonly fontSize: number;
  /** The computed line height in pixels, or `null` for `normal`. */
  readonly lineHeight: number | null;
  readonly fontWeight: number;
  /** How many runs of text use it. */
  readonly count: number;
  /** Whether any of those runs wraps onto a second line, which is when line height shows. */
  readonly multiline: boolean;
  readonly sample: string;
}

/** One border as drawn: who draws it, how thick, and how strongly it reads against its ground. */
export interface BorderFact {
  readonly name: string;
  readonly width: number;
  /** The line the border is drawn with: `solid`, `dashed`, `dotted`. */
  readonly style: string;
  /** The WCAG contrast ratio of the border, composited, against the surface outside it. */
  readonly contrast: number;
  /** Whether the element is a control, whose boundary WCAG 1.4.11 covers. */
  readonly interactive: boolean;
  readonly count: number;
}

/** A left edge that content starts at, and how much content starts there. */
export interface EdgeFact {
  readonly x: number;
  readonly count: number;
  readonly samples: readonly string[];
}

/** The vertical gaps between the stacked children of one container. */
export interface StackFact {
  readonly name: string;
  /** Whether every child is the same kind of element, so their gaps should match. */
  readonly uniformChildren: boolean;
  readonly gaps: readonly number[];
  /** The distinct left edges its children's content starts on, lists and quotations aside. */
  readonly lefts: readonly number[];
  /** The distinct right edges its wide, boxed children end on. */
  readonly rights: readonly number[];
}

/** A wide row whose content starts well inside its leading edge. */
export interface LeadingSpaceFact {
  readonly name: string;
  /** The row's content-box inline size. */
  readonly width: number;
  /** The empty distance from the row's leading edge to its first content. */
  readonly leading: number;
  /** The empty distance from its last content to its trailing edge. */
  readonly trailing: number;
  /** The index, in the same list, of the nearest row around this one, or `null` for an outermost row. */
  readonly within: number | null;
  readonly sample: string;
}

/** One thing drawn over another where a person needs to read or press it. */
export interface OverlapFact {
  /**
   * `covered`: part of a control sits under another element. `faded`: a scroll fade paints over a
   * control. `over-text`: a control lifted out of the flow sits on a line of text.
   */
  readonly kind: 'covered' | 'faded' | 'over-text';
  /** The control. */
  readonly subject: string;
  readonly label: string;
  /** What covers it, or for `over-text` the text it covers. */
  readonly by: string;
  /** The share of the control, or of the line, that is covered, from 0 to 1. */
  readonly amount: number;
}

/** A box with more room above its content than below it. */
export interface InsetFact {
  readonly name: string;
  readonly above: number;
  readonly below: number;
  readonly sample: string;
}

/** How much of the viewport the chrome around the page's scrolling region takes. */
export interface ChromeFact {
  /** The region the content scrolls in. */
  readonly name: string;
  /** The pixels of viewport above it. */
  readonly top: number;
  /** The pixels of viewport below it: a composer, a docked bar, a drawer. */
  readonly bottom: number;
}

/** What the probe measured on one captured page. */
export interface GeometryFacts {
  readonly viewport: { readonly width: number; readonly height: number };
  /** Whether the page matched `(pointer: coarse)`, so its touch-only styles applied. */
  readonly pointerCoarse: boolean;
  /** Cinder's spacing scale in pixels, read from the page's `--cinder-space-*` properties. */
  readonly spaceScale: readonly number[];
  readonly controls: readonly ControlFact[];
  readonly textStyles: readonly TextStyleFact[];
  readonly borders: readonly BorderFact[];
  readonly edges: readonly EdgeFact[];
  readonly stacks: readonly StackFact[];
  readonly leadingSpace: readonly LeadingSpaceFact[];
  readonly overlaps: readonly OverlapFact[];
  readonly insets: readonly InsetFact[];
  /** `null` when nothing on the page scrolls. */
  readonly chrome: ChromeFact | null;
}

/** The fields of a manifest line the audit reads. */
export interface GeometryCapture {
  readonly route: string;
  readonly state: string;
  readonly tab?: string;
  readonly source: string;
  readonly width: number;
  readonly colorScheme: 'light' | 'dark';
  readonly viewport: string;
  /** The measured facts, relative to the capture directory; absent on a capture taken without the probe. */
  readonly geometry?: string;
}

/**
 * The numbers the audit holds a page to. The rubric's "Craft" section states each one as a rule and
 * cites this object, so a threshold changes here and nowhere else.
 */
export const GEOMETRY_THRESHOLDS = {
  /** A button label needs at least this many times the room beside it as above it. */
  buttonPaddingRatioMinimum: 1.5,
  /** How many forms one job's button may take under one pointer before the inventory lists it. */
  formsPerJobMaximum: 2,
  /** At or below this viewport width a page is a phone layout. */
  phoneWidthMaximum: 480,
  /** A single-line control drawn taller than this on a phone is oversized. */
  phoneControlHeightMaximum: 48,
  /**
   * A button drawn taller than this on a phone or a touch screen is oversized. A minimum target is
   * not a goal: the drawn size and the hit area are two numbers.
   */
  touchButtonHeightMaximum: 36,
  /** On a touch screen the area that takes a tap is at least this on both axes (HIG, WCAG 2.5.5). */
  touchTargetMinimum: 44,
  /** Icon buttons in a row sit no further apart, center to center, than this many times their glyph. */
  iconPitchRatioMaximum: 2.5,
  /** Fixed chrome below the scrolling region takes at most this share of a phone's height. */
  bottomChromeShareMaximum: 0.35,
  /** The children of one container start on at most this many left edges, and end on as many right edges. */
  siblingEdgesMaximum: 2,
  /** A box may have this much more room above its content than below it. */
  insetImbalanceMaximum: 4,
  /** A control this much under a fade, as a share of its height, is covered by it. */
  fadedShareMinimum: 0.25,
  /** A button this share of a phone's width, with a label this short, is stretched. */
  stretchedButtonWidthShare: 0.8,
  shortLabelCharacters: 16,
  /** A control smaller than this on either axis, with no extended hit area, fails WCAG 2.5.8. */
  targetMinimum: 24,
  /** A page that sets text in more sizes than this has no type scale. */
  fontSizesMaximum: 6,
  /** Wrapped text reads best with a line height in this range, as a multiple of its size. */
  lineHeightRatioMinimum: 1.3,
  lineHeightRatioMaximum: 1.7,
  /** Above this size text is a display heading, which may be set tighter. */
  bodyFontSizeMaximum: 20,
  /** One size of wrapped text in more line heights than this is inconsistent. */
  lineHeightsPerSizeMaximum: 2,
  /** Text smaller than this is not readable. */
  fontSizeMinimum: 11,
  /** A border between surface and content should read no more strongly than this. */
  structuralBorderContrastMaximum: 1.5,
  /**
   * A control's resting border should read no more strongly than this: Cinder's `border.control`
   * is quiet by owner decision and reaches 3:1 only under `prefers-contrast: more`.
   */
  controlBorderContrastMaximum: 3,
  /** A border thicker than this is weight, not separation. */
  borderWidthMaximum: 1,
  /** A page drawing structural borders in more weights than this is inconsistent. */
  structuralBorderWeightsMaximum: 3,
  /** Left edges closer than the first are aligned; up to the second they are a near miss. */
  edgeAlignedWithin: 1,
  edgeNearMissWithin: 4,
  /** A gap wider than this is slack a layout hands out (a spacer, `margin: auto`), not spacing. */
  gapSlackAbove: 64,
  /** A row whose content starts this far in, as a share of its width, wastes its leading side. */
  leadingSpaceShare: 0.25,
  leadingSpaceMinimum: 48,
  /** Content with this much less room after it than before it is pushed, not centered. */
  leadingSpaceImbalanceShare: 0.15,
} as const;

/** Every rule, in the order the report lists them, with the heading and the principle it states. */
export const GEOMETRY_RULES = {
  'edge-near-miss': {
    title: 'Near-miss alignment',
    principle: `Content starts on shared left edges. Two edges between ${GEOMETRY_THRESHOLDS.edgeAlignedWithin} and ${GEOMETRY_THRESHOLDS.edgeNearMissWithin} pixels apart are a mistake, not a decision.`,
  },
  'gap-off-scale': {
    title: 'Gaps off the spacing scale',
    principle: "Every gap between siblings is a step of Cinder's spacing scale.",
  },
  'gap-uneven': {
    title: 'Uneven gaps between like siblings',
    principle: 'Siblings of one kind sit at one distance from each other.',
  },
  'edge-many': {
    title: 'Too many edges among siblings',
    principle: `The children of one container start on at most ${GEOMETRY_THRESHOLDS.siblingEdgesMaximum} left edges, and its boxes end on at most ${GEOMETRY_THRESHOLDS.siblingEdgesMaximum} right edges. Lists, quotations and code set their own.`,
  },
  'inset-uneven': {
    title: 'More room above than below',
    principle: `A box has the same room above its content as below it, within ${GEOMETRY_THRESHOLDS.insetImbalanceMaximum} pixels. More above is a row sized by something other than its text, or two paddings stacked.`,
  },
  'leading-space': {
    title: 'Empty leading side',
    principle: `A row's content starts at its leading edge. Content that starts more than ${GEOMETRY_THRESHOLDS.leadingSpaceShare * 100}% of the way across leaves the side a person reads first empty.`,
  },
  'button-padding-ratio': {
    title: 'Button padding ratio',
    principle: `A button's label has at least ${GEOMETRY_THRESHOLDS.buttonPaddingRatioMinimum} times the room beside it as above it; two times is the target.`,
  },
  'target-oversized': {
    title: 'Oversized controls on a phone',
    principle: `On a phone or a touch screen a button is drawn no taller than ${GEOMETRY_THRESHOLDS.touchButtonHeightMaximum} pixels, and any other single-line control no taller than ${GEOMETRY_THRESHOLDS.phoneControlHeightMaximum}. A touch target grows through its hit area, not its drawn size: ${GEOMETRY_THRESHOLDS.touchTargetMinimum} pixels is a minimum for the hit area and never a size to draw.`,
  },
  'hit-takes-space': {
    title: 'Hit areas that take layout space',
    principle: `On a touch screen a button's layout box is its painted face. One that paints ${GEOMETRY_THRESHOLDS.touchButtonHeightMaximum} pixels or less but takes more in the layout (a transparent border, a minimum size) pushes its neighbors away by room nobody sees: wide icon pitch, swollen title rows and dead bands inside cards. The hit area grows through something that takes no space, such as a positioned pseudo-element.`,
  },
  'hit-unreached': {
    title: 'Hit areas a tap does not reach',
    principle: `On a touch screen a tap ${GEOMETRY_THRESHOLDS.touchTargetMinimum / 2} pixels from a control's center reaches the control, on every side in view. A hit area the styles extend but a parent clips, the next row paints over, or a bar cuts is not there: give the parent room for the overhang, or stop what covers it from taking the tap. A neighboring control's own hit area may take the point; anything else may not.`,
  },
  'icon-pitch': {
    title: 'Icon buttons spaced too far apart',
    principle: `Icon buttons in one row sit at most ${GEOMETRY_THRESHOLDS.iconPitchRatioMaximum} times their glyph apart, center to center. Their hit areas may meet or overlap invisibly; their glyphs read as one group.`,
  },
  'chrome-share': {
    title: 'Fixed chrome crowding a phone',
    principle: `What stays fixed below the scrolling region (a composer, a docked bar, a drawer) takes at most ${GEOMETRY_THRESHOLDS.bottomChromeShareMaximum * 100}% of a phone's height.`,
  },
  occluded: {
    title: 'Covered controls and text',
    principle:
      'Nothing a person presses or reads is partly covered: no control half under a bar, a card or a scroll fade, and no control lying on a line of text. A control is fully in view or fully out.',
  },
  'button-stretched': {
    title: 'Short labels stretched across a phone',
    principle: `A button with a label of ${GEOMETRY_THRESHOLDS.shortLabelCharacters} characters or fewer does not span ${GEOMETRY_THRESHOLDS.stretchedButtonWidthShare * 100}% of a phone unless it is the one primary action of a form or dialog.`,
  },
  'button-wordy': {
    title: 'Wordy buttons on a phone',
    principle: `A phone button's label is ${GEOMETRY_THRESHOLDS.shortLabelCharacters} characters or fewer. A longer one is a candidate for an icon with an accessible label and a tooltip.`,
  },
  'target-undersized': {
    title: 'Undersized targets',
    principle: `A control's hit area is at least ${GEOMETRY_THRESHOLDS.targetMinimum} by ${GEOMETRY_THRESHOLDS.targetMinimum} pixels (WCAG 2.5.8), and at least ${GEOMETRY_THRESHOLDS.touchTargetMinimum} by ${GEOMETRY_THRESHOLDS.touchTargetMinimum} on a touch screen. The hit area may extend past what is drawn.`,
  },
  'type-sizes': {
    title: 'Too many type sizes',
    principle: `A page sets text in at most ${GEOMETRY_THRESHOLDS.fontSizesMaximum} sizes.`,
  },
  'line-height': {
    title: 'Line height out of range',
    principle: `Wrapped text up to ${GEOMETRY_THRESHOLDS.bodyFontSizeMaximum} pixels has a line height between ${GEOMETRY_THRESHOLDS.lineHeightRatioMinimum} and ${GEOMETRY_THRESHOLDS.lineHeightRatioMaximum} times its size.`,
  },
  'line-height-mixed': {
    title: 'One size, several line heights',
    principle: `Wrapped text of one size uses at most ${GEOMETRY_THRESHOLDS.lineHeightsPerSizeMaximum} line heights on a page.`,
  },
  'text-tiny': {
    title: 'Text too small',
    principle: `No text is smaller than ${GEOMETRY_THRESHOLDS.fontSizeMinimum} pixels.`,
  },
  'border-heavy': {
    title: 'Heavy borders',
    principle: `A border between a surface and its content reads at no more than ${GEOMETRY_THRESHOLDS.structuralBorderContrastMaximum}:1 against the surface outside it, and a control's border at no more than ${GEOMETRY_THRESHOLDS.controlBorderContrastMaximum}:1.`,
  },
  'border-thick': {
    title: 'Thick borders',
    principle: `A border is ${GEOMETRY_THRESHOLDS.borderWidthMaximum} pixel wide. Emphasis comes from color or fill, not thickness.`,
  },
  'border-mixed': {
    title: 'Inconsistent border weights',
    principle: `A page draws its structural borders in at most ${GEOMETRY_THRESHOLDS.structuralBorderWeightsMaximum} weights, counting a dashed line as a weight of its own. A dashed border means one thing on a page.`,
  },
} as const;

/** The name of a rule. */
export type GeometryRule = keyof typeof GEOMETRY_RULES;

/** One rule broken on one capture. */
export interface GeometryFinding {
  readonly rule: GeometryRule;
  /** What broke it, the same on every capture that shows the same defect. */
  readonly subject: string;
  /** The measured values, in words. */
  readonly measured: string;
  readonly capture: GeometryCapture;
}

/** One defect, with every capture that shows it. */
export interface ConsolidatedFinding {
  readonly rule: GeometryRule;
  readonly subject: string;
  /** The measured values on the first capture that showed it. */
  readonly measured: string;
  /** How many captures show it. */
  readonly captures: number;
  readonly widths: readonly number[];
  readonly routes: readonly string[];
  /** Up to five screenshots that show it, relative to the capture directory. */
  readonly examples: readonly string[];
}

/** How much of a capture directory the audit could read. */
export interface GeometryCoverage {
  /** The lines of the manifest. */
  readonly captures: number;
  /** The captures that carry measured facts. */
  readonly measured: number;
  /** The measured captures that emulated a coarse pointer. */
  readonly coarse: number;
  /** The measured captures whose page declared no spacing scale, so their gaps went unjudged. */
  readonly unscaled: number;
}

/** The stress seed's pathological text says nothing about labels or where content starts. */
const STRESS_SOURCE = 'responsive.spec.ts';

const EXAMPLES_MAXIMUM = 5;

/** Fewer steps than this is a scale the probe failed to read, not a scale. */
const SCALE_STEPS_MINIMUM = 3;

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** The empty room beside and above a control's content, or `null` when it draws none. */
function controlPadding(control: ControlFact): { inline: number; block: number } | null {
  const { rect, content } = control;
  if (content === null) return null;
  const before = content.x - rect.x;
  const after = rect.x + rect.width - (content.x + content.width);
  const above = content.y - rect.y;
  const below = rect.y + rect.height - (content.y + content.height);
  return { inline: Math.min(before, after), block: (above + below) / 2 };
}

function auditControls(facts: GeometryFacts, capture: GeometryCapture): GeometryFinding[] {
  const thresholds = GEOMETRY_THRESHOLDS;
  const phone = facts.viewport.width <= thresholds.phoneWidthMaximum;
  const stress = capture.source === STRESS_SOURCE;
  const findings: GeometryFinding[] = [];
  const add = (rule: GeometryRule, control: ControlFact, measured: string): void => {
    findings.push({ rule, subject: control.name, measured, capture });
  };
  for (const control of facts.controls) {
    const { rect } = control;
    const label = control.text === '' ? control.accessibleLabel : control.text;
    const padding = controlPadding(control);
    if (
      control.kind === 'button' &&
      control.boxed &&
      control.text !== '' &&
      !control.fullWidth &&
      padding !== null &&
      padding.block >= 1 &&
      padding.inline / padding.block < thresholds.buttonPaddingRatioMinimum
    ) {
      add(
        'button-padding-ratio',
        control,
        `"${label}": ${round(padding.inline)}px beside the label, ${round(padding.block)}px above and below (${round(padding.inline / padding.block)} to 1) in a ${round(rect.height)}px button`,
      );
    }
    if ((phone || facts.pointerCoarse) && control.kind !== 'field' && !control.inline) {
      const singleLine = control.content !== null && control.content.height <= control.fontSize * 2;
      // A button that draws no box shows only its label or glyph, whatever area takes the tap.
      const drawn = control.kind === 'button' && !control.boxed ? 0 : control.rect.height;
      const limit =
        control.kind === 'button'
          ? thresholds.touchButtonHeightMaximum
          : thresholds.phoneControlHeightMaximum;
      if (singleLine && drawn > limit) {
        add(
          'target-oversized',
          control,
          `"${label}" is drawn ${round(control.rect.height)}px tall, over the ${limit}px limit; its hit area is ${round(control.hit.height)}px`,
        );
      }
    }
    if (facts.pointerCoarse && control.kind === 'button' && !control.inline) {
      const painted = control.boxed ? rect.height : (control.content?.height ?? 0);
      const limit = thresholds.touchButtonHeightMaximum;
      if (painted <= limit && control.layout.height > limit) {
        add(
          'hit-takes-space',
          control,
          `"${label}" paints ${round(painted)}px tall and takes ${round(control.layout.height)}px in the layout`,
        );
      }
    }
    if (phone && control.kind !== 'field' && !control.inline) {
      if (
        control.kind === 'button' &&
        control.boxed &&
        control.text !== '' &&
        control.text.length <= thresholds.shortLabelCharacters &&
        rect.width >= facts.viewport.width * thresholds.stretchedButtonWidthShare
      ) {
        add(
          'button-stretched',
          control,
          `"${label}" spans ${round(rect.width)}px of a ${facts.viewport.width}px phone`,
        );
      }
      if (
        !stress &&
        control.kind === 'button' &&
        control.boxed &&
        control.labelRuns === 1 &&
        control.text.length > thresholds.shortLabelCharacters
      ) {
        add(
          'button-wordy',
          control,
          `"${label}" is ${control.text.length} characters and ${round(rect.width)}px wide`,
        );
      }
    }
    // A text field is as wide as its row, so it is held to the touch minimum only by its height's floor.
    const minimum =
      facts.pointerCoarse && control.kind !== 'field' && control.lineAction !== true
        ? thresholds.touchTargetMinimum
        : thresholds.targetMinimum;
    if (!control.inline && Math.min(control.hit.width, control.hit.height) < minimum) {
      add(
        'target-undersized',
        control,
        `"${label}" takes a tap over ${round(control.hit.width)} by ${round(control.hit.height)}px, under the ${minimum}px minimum${minimum === thresholds.touchTargetMinimum ? ' on a touch screen' : ''}; it is drawn ${round(rect.width)} by ${round(rect.height)}px`,
      );
    } else if (
      facts.pointerCoarse &&
      control.kind !== 'field' &&
      control.lineAction !== true &&
      !control.inline &&
      (control.unreached ?? []).length > 0 &&
      // One covered control is one finding: the covering check names what lies on its face.
      !facts.overlaps.some(
        (overlap) =>
          overlap.kind === 'covered' && overlap.subject === control.name && overlap.label === label,
      )
    ) {
      add(
        'hit-unreached',
        control,
        `"${label}" claims a ${round(control.hit.width)} by ${round(control.hit.height)}px hit area that a tap does not reach: ${(control.unreached ?? []).join(', ')}`,
      );
    }
  }
  findings.push(...auditIconPitch(facts, capture));
  return findings;
}

/** Icon-only controls that share a parent and a row, held to the pitch their glyphs can carry. */
function auditIconPitch(facts: GeometryFacts, capture: GeometryCapture): GeometryFinding[] {
  const findings: GeometryFinding[] = [];
  const rows = new Map<string, ControlFact[]>();
  for (const control of facts.controls) {
    if (control.text !== '' || control.content === null || control.kind === 'field') continue;
    const key = `${control.parent}|${Math.round((control.rect.y + control.rect.height / 2) / 4)}`;
    rows.set(key, [...(rows.get(key) ?? []), control]);
  }
  for (const row of rows.values()) {
    const ordered = row.toSorted((left, right) => left.rect.x - right.rect.x);
    for (const [index, control] of ordered.entries()) {
      const next = ordered[index + 1];
      if (next === undefined || control.content === null || next.content === null) continue;
      const glyph = Math.max(control.content.width, next.content.width);
      const pitch =
        next.content.x + next.content.width / 2 - (control.content.x + control.content.width / 2);
      // Buttons at the two ends of a bar are apart by layout, not by spacing.
      if (pitch - glyph > GEOMETRY_THRESHOLDS.gapSlackAbove) continue;
      if (glyph < 1 || pitch <= glyph * GEOMETRY_THRESHOLDS.iconPitchRatioMaximum) continue;
      findings.push({
        rule: 'icon-pitch',
        subject: `${control.name} and ${next.name}`,
        measured: `"${control.accessibleLabel}" and "${next.accessibleLabel}": ${round(glyph)}px glyphs ${round(pitch)}px apart (${round(pitch / glyph)} times the glyph)`,
        capture,
      });
      break;
    }
  }
  return findings;
}

function auditType(facts: GeometryFacts, capture: GeometryCapture): GeometryFinding[] {
  const thresholds = GEOMETRY_THRESHOLDS;
  const findings: GeometryFinding[] = [];
  // Text set at no size is hidden on purpose, so it is not part of the page's type.
  const styles = facts.textStyles.filter((style) => style.fontSize >= 1);
  const sizes = [...new Set(styles.map((style) => style.fontSize))].toSorted(
    (left, right) => left - right,
  );
  if (sizes.length > thresholds.fontSizesMaximum) {
    findings.push({
      rule: 'type-sizes',
      subject: 'page type scale',
      measured: `${sizes.length} sizes: ${sizes.map((size) => `${round(size)}px`).join(', ')}`,
      capture,
    });
  }
  const lineHeightsBySize = new Map<number, Set<number>>();
  for (const style of styles) {
    if (!style.multiline || style.lineHeight === null) continue;
    const heights = lineHeightsBySize.get(style.fontSize) ?? new Set<number>();
    heights.add(round(style.lineHeight));
    lineHeightsBySize.set(style.fontSize, heights);
    if (style.fontSize > thresholds.bodyFontSizeMaximum) continue;
    const ratio = Math.round((style.lineHeight / style.fontSize) * 100) / 100;
    if (ratio < thresholds.lineHeightRatioMinimum || ratio > thresholds.lineHeightRatioMaximum) {
      findings.push({
        rule: 'line-height',
        subject: `${round(style.fontSize)}px text at ${round(style.lineHeight)}px line height`,
        measured: `${round(ratio)} times its size, as in "${style.sample}"`,
        capture,
      });
    }
  }
  for (const [fontSize, heights] of lineHeightsBySize) {
    if (heights.size <= thresholds.lineHeightsPerSizeMaximum) continue;
    const listed = [...heights].toSorted((left, right) => left - right);
    findings.push({
      rule: 'line-height-mixed',
      subject: `${round(fontSize)}px text`,
      measured: `line heights of ${listed.map((height) => `${height}px`).join(', ')}`,
      capture,
    });
  }
  for (const style of styles) {
    if (style.fontSize >= thresholds.fontSizeMinimum) continue;
    findings.push({
      rule: 'text-tiny',
      subject: `${round(style.fontSize)}px text`,
      measured: `as in "${style.sample}"`,
      capture,
    });
  }
  return findings;
}

function auditBorders(facts: GeometryFacts, capture: GeometryCapture): GeometryFinding[] {
  const thresholds = GEOMETRY_THRESHOLDS;
  const findings: GeometryFinding[] = [];
  const structuralWeights = new Set<string>();
  for (const border of facts.borders) {
    const limit = border.interactive
      ? thresholds.controlBorderContrastMaximum
      : thresholds.structuralBorderContrastMaximum;
    if (!border.interactive) {
      structuralWeights.add(
        `${border.style === 'solid' ? '' : `${border.style} `}${round(border.contrast)}:1`,
      );
    }
    if (border.contrast > limit) {
      findings.push({
        rule: 'border-heavy',
        subject: border.name,
        measured: `${round(border.contrast)}:1 against the surface outside it, over the ${limit}:1 limit for a ${border.interactive ? 'control' : 'structural'} border`,
        capture,
      });
    }
    if (border.width > thresholds.borderWidthMaximum) {
      findings.push({
        rule: 'border-thick',
        subject: border.name,
        measured: `${round(border.width)}px wide`,
        capture,
      });
    }
  }
  if (structuralWeights.size > thresholds.structuralBorderWeightsMaximum) {
    const listed = [...structuralWeights].toSorted((left, right) => left.localeCompare(right));
    findings.push({
      rule: 'border-mixed',
      subject: 'structural borders',
      measured: `${listed.length} weights: ${listed.join(', ')}`,
      capture,
    });
  }
  return findings;
}

function auditEdges(facts: GeometryFacts, capture: GeometryCapture): GeometryFinding[] {
  const thresholds = GEOMETRY_THRESHOLDS;
  const findings: GeometryFinding[] = [];
  const edges = facts.edges
    .filter((edge) => edge.count >= 2)
    .toSorted((left, right) => left.x - right.x);
  for (const [index, edge] of edges.entries()) {
    const next = edges[index + 1];
    if (next === undefined) continue;
    const distance = next.x - edge.x;
    if (distance <= thresholds.edgeAlignedWithin || distance > thresholds.edgeNearMissWithin) {
      continue;
    }
    findings.push({
      rule: 'edge-near-miss',
      subject: `${edge.samples[0] ?? 'content'} and ${next.samples[0] ?? 'content'}`,
      measured: `left edges at ${round(edge.x)}px (${edge.count} elements) and ${round(next.x)}px (${next.count} elements), ${round(distance)}px apart`,
      capture,
    });
  }
  return findings;
}

function auditStacks(facts: GeometryFacts, capture: GeometryCapture): GeometryFinding[] {
  const findings: GeometryFinding[] = [];
  const stress = capture.source === STRESS_SOURCE;
  const onScale = (gap: number): boolean =>
    gap <= 0.5 ||
    gap > GEOMETRY_THRESHOLDS.gapSlackAbove ||
    facts.spaceScale.some((step) => Math.abs(step - gap) <= 0.5);
  for (const stack of facts.stacks) {
    const distinct = [...new Set(stack.gaps.map((gap) => round(gap)))].toSorted(
      (left, right) => left - right,
    );
    for (const gap of distinct) {
      if (facts.spaceScale.length < SCALE_STEPS_MINIMUM || onScale(gap)) continue;
      findings.push({
        rule: 'gap-off-scale',
        subject: `${stack.name} at ${gap}px`,
        measured: `a ${gap}px gap between its children, among gaps of ${distinct.map((value) => `${value}px`).join(', ')}`,
        capture,
      });
    }
    const first = distinct[0];
    const last = distinct.at(-1);
    if (stack.uniformChildren && first !== undefined && last !== undefined && last - first >= 1) {
      findings.push({
        rule: 'gap-uneven',
        subject: stack.name,
        measured: `like children spaced ${distinct.map((value) => `${value}px`).join(', ')} apart`,
        capture,
      });
    }
    for (const [side, edges] of [
      ['left', clusterEdges(stack.lefts)],
      ['right', clusterEdges(stack.rights)],
    ] as const) {
      if (stress || edges.length <= GEOMETRY_THRESHOLDS.siblingEdgesMaximum) continue;
      findings.push({
        rule: 'edge-many',
        subject: `${stack.name} ${side} edges`,
        measured: `its children ${side === 'left' ? 'start' : 'end'} on ${edges.length} ${side} edges: ${edges.map((edge) => `${edge}px`).join(', ')}`,
        capture,
      });
    }
  }
  return findings;
}

/** Edges within a pixel of each other are one edge. */
function clusterEdges(edges: readonly number[]): number[] {
  const clustered: number[] = [];
  for (const edge of edges.toSorted((left, right) => left - right)) {
    const last = clustered.at(-1);
    if (last === undefined || edge - last > GEOMETRY_THRESHOLDS.edgeAlignedWithin) {
      clustered.push(edge);
    }
  }
  return clustered;
}

function auditOverlaps(facts: GeometryFacts, capture: GeometryCapture): GeometryFinding[] {
  const thresholds = GEOMETRY_THRESHOLDS;
  const findings: GeometryFinding[] = [];
  for (const overlap of facts.overlaps) {
    const share = Math.round(overlap.amount * 100);
    if (overlap.kind === 'faded') {
      if (overlap.amount < thresholds.fadedShareMinimum) continue;
      findings.push({
        rule: 'occluded',
        subject: `${overlap.subject} under the fade of ${overlap.by}`,
        measured: `a scroll fade paints over ${share}% of "${overlap.label}"`,
        capture,
      });
    } else if (overlap.kind === 'covered') {
      findings.push({
        rule: 'occluded',
        subject: `${overlap.subject} under ${overlap.by}`,
        measured: `"${overlap.label}" is partly covered: ${share}% of the points sampled on it`,
        capture,
      });
    } else {
      findings.push({
        rule: 'occluded',
        subject: `${overlap.subject} over ${overlap.by}`,
        measured: `"${overlap.label}" lies on a line of text, covering ${share}% of its height`,
        capture,
      });
    }
  }
  return findings;
}

function auditInsets(facts: GeometryFacts, capture: GeometryCapture): GeometryFinding[] {
  if (capture.source === STRESS_SOURCE) return [];
  const findings: GeometryFinding[] = [];
  for (const inset of facts.insets) {
    if (inset.above - inset.below <= GEOMETRY_THRESHOLDS.insetImbalanceMaximum) continue;
    findings.push({
      rule: 'inset-uneven',
      subject: inset.name,
      measured: `${round(inset.above)}px above its content ("${inset.sample}") and ${round(inset.below)}px below`,
      capture,
    });
  }
  return findings;
}

function auditChrome(facts: GeometryFacts, capture: GeometryCapture): GeometryFinding[] {
  const thresholds = GEOMETRY_THRESHOLDS;
  const { chrome, viewport } = facts;
  if (chrome === null || viewport.width > thresholds.phoneWidthMaximum) return [];
  if (chrome.bottom <= viewport.height * thresholds.bottomChromeShareMaximum) return [];
  return [
    {
      rule: 'chrome-share',
      subject: `chrome below ${chrome.name}`,
      measured: `${round(chrome.bottom)}px of a ${viewport.height}px viewport (${Math.round((chrome.bottom / viewport.height) * 100)}%) stays fixed below the scrolling region, and ${round(chrome.top)}px above it`,
      capture,
    },
  ];
}

function auditLeadingSpace(facts: GeometryFacts, capture: GeometryCapture): GeometryFinding[] {
  const thresholds = GEOMETRY_THRESHOLDS;
  if (capture.source === STRESS_SOURCE) return [];
  const findings: GeometryFinding[] = [];
  // A row inside a row that already broke the rule is the same empty space, reported once.
  const broken = new Set<number>();
  for (const [index, row] of facts.leadingSpace.entries()) {
    if (row.within !== null && broken.has(row.within)) {
      broken.add(index);
      continue;
    }
    if (
      row.width <= 0 ||
      row.leading < thresholds.leadingSpaceMinimum ||
      row.leading < row.width * thresholds.leadingSpaceShare ||
      row.leading - row.trailing < row.width * thresholds.leadingSpaceImbalanceShare
    ) {
      continue;
    }
    broken.add(index);
    findings.push({
      rule: 'leading-space',
      subject: row.name,
      measured: `content ("${row.sample}") starts ${round(row.leading)}px in, ${Math.round((row.leading / row.width) * 100)}% of a ${round(row.width)}px row, with ${round(row.trailing)}px after it`,
      capture,
    });
  }
  return findings;
}

/** Holds one capture's measured facts to every rule. */
export function auditCapture(facts: GeometryFacts, capture: GeometryCapture): GeometryFinding[] {
  return [
    ...auditControls(facts, capture),
    ...auditType(facts, capture),
    ...auditBorders(facts, capture),
    ...auditEdges(facts, capture),
    ...auditStacks(facts, capture),
    ...auditLeadingSpace(facts, capture),
    ...auditOverlaps(facts, capture),
    ...auditInsets(facts, capture),
    ...auditChrome(facts, capture),
  ];
}

/** Folds findings that share a rule and a subject, ordered by rule and then by how widespread each is. */
export function consolidateFindings(findings: readonly GeometryFinding[]): ConsolidatedFinding[] {
  const groups = new Map<string, GeometryFinding[]>();
  for (const finding of findings) {
    const key = `${finding.rule}\n${finding.subject}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [finding]);
    else group.push(finding);
  }
  const order = Object.keys(GEOMETRY_RULES);
  return [...groups.values()]
    .map((group): ConsolidatedFinding => {
      const [first] = group as [GeometryFinding, ...GeometryFinding[]];
      const screenshots = [...new Set(group.map((finding) => finding.capture.viewport))];
      return {
        rule: first.rule,
        subject: first.subject,
        measured: first.measured,
        captures: screenshots.length,
        widths: [...new Set(group.map((finding) => finding.capture.width))].toSorted(
          (left, right) => left - right,
        ),
        routes: [...new Set(group.map((finding) => finding.capture.route))].toSorted(),
        examples: screenshots.slice(0, EXAMPLES_MAXIMUM),
      };
    })
    .toSorted(
      (left, right) =>
        order.indexOf(left.rule) - order.indexOf(right.rule) ||
        right.captures - left.captures ||
        left.subject.localeCompare(right.subject),
    );
}

/** A table cell cannot hold a pipe or a line break. */
/** Labels that ask for the same thing, so a screen that uses two of them has two patterns for one job. */
export const LABEL_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  retry: ['retry', 'try again', 'ask again', 'run again', 'send again', 'resend'],
  dismiss: ['dismiss', 'close', 'hide', 'got it'],
  cancel: ['cancel', 'stop', 'abort'],
};

/** One job a button does, and every way the captures draw it. */
export interface PatternEntry {
  /** The family name, or the label itself when it belongs to none. */
  readonly job: string;
  /** Every label the job is asked with. */
  readonly labels: readonly string[];
  /** Every form it is drawn in under one pointer: name, variant, painted height, boxed or bare. */
  readonly forms: readonly string[];
  readonly pointer: 'touch' | 'mouse';
  readonly examples: readonly string[];
}

function jobOf(label: string): string {
  const lower = label.toLowerCase().replace(/[.…!]+$/, '');
  for (const [family, labels] of Object.entries(LABEL_FAMILIES)) {
    if (labels.includes(lower)) return family;
  }
  return lower;
}

/**
 * Groups every labelled button across the captures by the job its label asks for, and answers the
 * jobs asked with more than one label or drawn in more than {@link GEOMETRY_THRESHOLDS.formsPerJobMaximum}
 * forms under one pointer. A reviewer reads it as the inventory "One pattern per job" asks for.
 */
export function inventoryPatterns(
  measured: readonly { readonly facts: GeometryFacts; readonly capture: GeometryCapture }[],
): PatternEntry[] {
  const jobs = new Map<
    string,
    { labels: Set<string>; forms: Set<string>; examples: Set<string>; job: string; coarse: boolean }
  >();
  for (const { facts, capture } of measured) {
    if (capture.source === STRESS_SOURCE) continue;
    for (const control of facts.controls) {
      if (control.kind !== 'button' || control.text === '' || control.labelRuns !== 1) continue;
      const job = jobOf(control.text);
      const key = `${job}|${facts.pointerCoarse}`;
      const entry = jobs.get(key) ?? {
        labels: new Set<string>(),
        forms: new Set<string>(),
        examples: new Set<string>(),
        job,
        coarse: facts.pointerCoarse,
      };
      entry.labels.add(control.text);
      const painted = control.boxed ? control.rect.height : (control.content?.height ?? 0);
      entry.forms.add(
        `${control.name}${control.variant === '' ? '' : `[variant=${control.variant}]`} ${Math.round(painted)}px ${control.boxed ? 'boxed' : 'bare'}`,
      );
      if (entry.examples.size < EXAMPLES_MAXIMUM) entry.examples.add(capture.viewport);
      jobs.set(key, entry);
    }
  }
  return [...jobs.values()]
    .filter(
      (entry) => entry.labels.size > 1 || entry.forms.size > GEOMETRY_THRESHOLDS.formsPerJobMaximum,
    )
    .map((entry) => ({
      job: entry.job,
      labels: [...entry.labels].toSorted(),
      forms: [...entry.forms].toSorted(),
      pointer: entry.coarse ? ('touch' as const) : ('mouse' as const),
      examples: [...entry.examples],
    }))
    .toSorted(
      (left, right) => right.forms.length - left.forms.length || left.job.localeCompare(right.job),
    );
}

function cell(text: string): string {
  return text.replaceAll('|', '/').replaceAll(/\s+/g, ' ');
}

/** The Markdown report a reviewer reads beside the screenshots. */
export function renderGeometryReport(
  findings: readonly ConsolidatedFinding[],
  coverage: GeometryCoverage,
  patterns: readonly PatternEntry[] = [],
): string {
  const lines = [
    '# Geometry audit',
    '',
    `Measured ${coverage.measured} of ${coverage.captures} captures. Each line is a measured fact held to a threshold in \`references/rubric.md\` "Craft", not a verdict: confirm it on a screenshot it names before reporting it, and route it Cinder first.`,
    '',
  ];
  if (coverage.measured > 0 && coverage.coarse === 0) {
    lines.push(
      'No capture emulated a coarse pointer, so styles under `@media (pointer: coarse)` (touch-sized rows, extended hit areas) did not apply: the phone widths show the mouse layout at a narrow width.',
      '',
    );
  }
  if (coverage.unscaled > 0) {
    lines.push(
      `${coverage.unscaled} measured captures declared no \`--cinder-space-*\` scale the probe could read, so the gaps on them were not held to it.`,
      '',
    );
  }
  if (findings.length === 0) lines.push('No findings.', '');
  for (const [rule, { title, principle }] of Object.entries(GEOMETRY_RULES)) {
    const found = findings.filter((finding) => finding.rule === rule);
    if (found.length === 0) continue;
    lines.push(`## ${title}`, '', principle, '');
    lines.push('| Subject | Measured | Captures | Widths | Routes | Examples |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const finding of found) {
      const routes =
        finding.routes.length > 4
          ? `${finding.routes.slice(0, 4).join(', ')} and ${finding.routes.length - 4} more`
          : finding.routes.join(', ');
      lines.push(
        `| ${cell(finding.subject)} | ${cell(finding.measured)} | ${finding.captures} | ${finding.widths.join(', ')} | ${cell(routes)} | ${finding.examples.map((example) => `\`${example}\``).join(' ')} |`,
      );
    }
    lines.push('');
  }
  if (patterns.length > 0) {
    lines.push(
      '## Pattern inventory',
      '',
      `Buttons grouped by the job their label asks for, across every capture but the stress pages. A job appears here when it is asked with more than one label or drawn in more than ${GEOMETRY_THRESHOLDS.formsPerJobMaximum} forms under one pointer. It is the inventory "One pattern per job" asks for: each line is a question (which form is the pattern?), not a defect on its own.`,
      '',
      '| Job | Pointer | Labels | Forms | Examples |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const entry of patterns) {
      lines.push(
        `| ${cell(entry.job)} | ${entry.pointer} | ${cell(entry.labels.map((label) => `"${label}"`).join(', '))} | ${cell(entry.forms.join('; '))} | ${entry.examples.map((example) => `\`${example}\``).join(' ')} |`,
      );
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
