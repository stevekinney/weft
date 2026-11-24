/**
 * Measures a captured page for the design review's geometry audit
 * (`scripts/design-review-geometry.ts`, which holds what this records to the rubric's thresholds).
 * `collectGeometryFacts` runs inside the page, so it is one self-contained function: Playwright
 * sends its source to the browser, and nothing outside its body exists there. It only reads the
 * page.
 *
 * It records what a reviewer cannot read off a screenshot: each control's box and the box of the
 * label and icons inside it, the sizes and line heights text is set in, each border's thickness and
 * its contrast against the surface outside it, the left edges content starts on, the gaps between
 * stacked siblings and the edges they start and end on, wide rows whose content starts far from
 * their leading edge, the area of each control that takes a tap, what covers a control or a line of
 * text, boxes with more room above their content than below it, and how much of the viewport the
 * chrome around the scrolling region takes.
 */
import type { Page } from '@playwright/test';

import type { GeometryFacts } from './design-review-geometry.ts';

/** Runs in the page: answers the facts the geometry audit reads. */
export function collectGeometryFacts(): GeometryFacts {
  const CONTROL_SELECTOR =
    'button, [role="button"], a[href], input:not([type="hidden"]), select, textarea, summary, [role="tab"], [role="menuitem"], [role="switch"], [role="checkbox"], [role="radio"]';
  const FIELD_SELECTOR = 'input, textarea, select, [contenteditable="true"], [role="textbox"]';
  const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const viewportWidth = window.innerWidth;

  interface Bounds {
    left: number;
    top: number;
    right: number;
    bottom: number;
  }

  function half(value: number): number {
    return Math.round(value * 2) / 2;
  }

  function boxOf(bounds: Bounds): { x: number; y: number; width: number; height: number } {
    return {
      x: half(bounds.left),
      y: half(bounds.top),
      width: half(bounds.right - bounds.left),
      height: half(bounds.bottom - bounds.top),
    };
  }

  function paintedBox(element: Element, rect: DOMRect, style: CSSStyleDeclaration): Bounds {
    const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0;
    const borderRight = Number.parseFloat(style.borderRightWidth) || 0;
    const borderTop = Number.parseFloat(style.borderTopWidth) || 0;
    const borderBottom = Number.parseFloat(style.borderBottomWidth) || 0;
    const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
    const paddingRight = Number.parseFloat(style.paddingRight) || 0;
    const paddingTop = Number.parseFloat(style.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
    const clip = style.backgroundClip;
    const left =
      clip === 'content-box' ? rect.left + borderLeft + paddingLeft : rect.left + borderLeft;
    const top = clip === 'content-box' ? rect.top + borderTop + paddingTop : rect.top + borderTop;
    const right =
      clip === 'content-box'
        ? rect.right - borderRight - paddingRight
        : clip === 'padding-box'
          ? rect.right - borderRight
          : rect.right;
    const bottom =
      clip === 'content-box'
        ? rect.bottom - borderBottom - paddingBottom
        : clip === 'padding-box'
          ? rect.bottom - borderBottom
          : rect.bottom;
    let clipped: Bounds = {
      left,
      top,
      right: Math.max(left, right),
      bottom: Math.max(top, bottom),
    };
    for (
      let ancestor = element.parentElement;
      ancestor !== null;
      ancestor = ancestor.parentElement
    ) {
      const ancestorStyle = getComputedStyle(ancestor);
      const clips = ['hidden', 'clip', 'auto', 'scroll'];
      if (!clips.includes(ancestorStyle.overflow) && !clips.includes(ancestorStyle.overflowY))
        continue;
      const ancestorBox = ancestor.getBoundingClientRect();
      clipped = {
        left: Math.max(clipped.left, ancestorBox.left + ancestor.clientLeft),
        top: Math.max(clipped.top, ancestorBox.top + ancestor.clientTop),
        right: Math.min(
          clipped.right,
          ancestorBox.left + ancestor.clientLeft + ancestor.clientWidth,
        ),
        bottom: Math.min(
          clipped.bottom,
          ancestorBox.top + ancestor.clientTop + ancestor.clientHeight,
        ),
      };
    }
    return clipped;
  }

  function isShown(element: Element): boolean {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;
    if (rect.right <= 0 || rect.left >= viewportWidth) return false;
    return element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  }

  function controlModifier(element: Element, kind: 'size' | 'variant'): string | null {
    const component = element.classList.contains('cinder-button')
      ? 'button'
      : element.classList.contains('cinder-select')
        ? 'select'
        : null;
    if (component === null) return element.getAttribute(`data-cinder-${kind}`);
    const prefix = `${component}-${kind}-`;
    return (
      [...element.classList].find((name) => name.startsWith(prefix))?.slice(prefix.length) ?? null
    );
  }

  function nameOf(element: Element): string {
    const classes = [...element.classList].filter((name) => !name.startsWith('svelte-'));
    const chosen = classes.find((name) => name.startsWith('cinder-')) ?? classes[0];
    const size = controlModifier(element, 'size');
    return `${element.tagName.toLowerCase()}${chosen === undefined ? '' : `.${chosen}`}${size === null ? '' : `[size=${size}]`}`;
  }

  function sampleOf(text: string): string {
    return text.replaceAll(/\s+/g, ' ').trim().slice(0, 60);
  }

  function union(bounds: Bounds | null, rect: DOMRect): Bounds {
    if (bounds === null) {
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    }
    return {
      left: Math.min(bounds.left, rect.left),
      top: Math.min(bounds.top, rect.top),
      right: Math.max(bounds.right, rect.right),
      bottom: Math.max(bounds.bottom, rect.bottom),
    };
  }

  /** The visible, non-blank text nodes directly or deeply inside `root`. */
  function textNodes(root: Element, deep: boolean): Text[] {
    const nodes: Text[] = [];
    if (!deep) {
      for (const child of root.childNodes) {
        if (child instanceof Text && child.data.trim() !== '') nodes.push(child);
      }
      return nodes;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!(node instanceof Text) || node.data.trim() === '' || parent === null) continue;
      if (SKIPPED_TAGS.has(parent.tagName) || parent.closest('svg') !== null) continue;
      if (isShown(parent)) nodes.push(node);
    }
    return nodes;
  }

  function rectsOf(node: Node): DOMRect[] {
    const range = document.createRange();
    range.selectNodeContents(node);
    return [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
  }

  /** The box around the visible text and icons inside an element. */
  function contentBounds(element: Element): Bounds | null {
    let bounds: Bounds | null = null;
    for (const node of textNodes(element, true)) {
      for (const rect of rectsOf(node)) bounds = union(bounds, rect);
    }
    for (const graphic of element.querySelectorAll('svg, img')) {
      if (isShown(graphic)) bounds = union(bounds, graphic.getBoundingClientRect());
    }
    return bounds;
  }

  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const resolvedColors = new Map<string, [number, number, number, number]>();

  /** A computed color as red, green and blue from 0 to 255 and alpha from 0 to 1. */
  function colorOf(value: string): [number, number, number, number] {
    const known = resolvedColors.get(value);
    if (known !== undefined) return known;
    let resolved: [number, number, number, number] = [0, 0, 0, 0];
    if (context !== null) {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = 'rgba(0, 0, 0, 0)';
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data;
      resolved = [red, green, blue, alpha / 255];
    }
    resolvedColors.set(value, resolved);
    return resolved;
  }

  function over(
    top: [number, number, number, number],
    bottom: [number, number, number],
  ): [number, number, number] {
    const alpha = top[3];
    return [
      top[0] * alpha + bottom[0] * (1 - alpha),
      top[1] * alpha + bottom[1] * (1 - alpha),
      top[2] * alpha + bottom[2] * (1 - alpha),
    ];
  }

  const page: [number, number, number] = window.matchMedia('(prefers-color-scheme: dark)').matches
    ? [18, 18, 18]
    : [255, 255, 255];
  const surfaces = new Map<Element, [number, number, number]>();

  /** The opaque color an element paints, composited over everything behind it. */
  function surfaceOf(element: Element | null): [number, number, number] {
    if (element === null) return page;
    const known = surfaces.get(element);
    if (known !== undefined) return known;
    const surface = over(
      colorOf(getComputedStyle(element).backgroundColor),
      surfaceOf(element.parentElement),
    );
    surfaces.set(element, surface);
    return surface;
  }

  function luminance([red, green, blue]: [number, number, number]): number {
    const channel = (value: number): number => {
      const scaled = value / 255;
      return scaled <= 0.040_45 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
  }

  function contrast(first: [number, number, number], second: [number, number, number]): number {
    const lighter = Math.max(luminance(first), luminance(second));
    const darker = Math.min(luminance(first), luminance(second));
    return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
  }

  /** Cinder's spacing steps in pixels, from the `--cinder-space-*` properties the page declares. */
  function spaceScale(): number[] {
    const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    const steps = new Set<number>();
    const visit = (rules: CSSRuleList): void => {
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule) {
          for (const property of rule.style) {
            if (!/^--cinder-space-[\d-]+$/.test(property)) continue;
            const declared = /^([\d.]+)(rem|px)?$/.exec(
              rule.style.getPropertyValue(property).trim(),
            );
            if (declared === null) continue;
            const amount = Number.parseFloat(declared[1] ?? '');
            steps.add(half(declared[2] === 'rem' ? amount * rootFontSize : amount));
          }
        }
        if ('cssRules' in rule && rule.cssRules instanceof CSSRuleList) visit(rule.cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        visit(sheet.cssRules);
      } catch {
        // A cross-origin sheet refuses to list its rules, and holds none of Cinder's tokens.
      }
    }
    return [...steps].toSorted((left, right) => left - right);
  }

  /** The box an absolutely positioned pseudo-element of `element` fills, when it has one. */
  function pseudoBounds(element: Element, pseudo: '::before' | '::after'): Bounds | null {
    const style = getComputedStyle(element, pseudo);
    if (style.content === 'none' || style.position !== 'absolute') return null;
    const own = getComputedStyle(element);
    // The pseudo-element is placed against this element only when this element is positioned.
    if (own.position === 'static') return null;
    const rect = element.getBoundingClientRect();
    const insetValues = [style.top, style.right, style.bottom, style.left].map((inset) =>
      Number.parseFloat(inset),
    );
    const [top = Number.NaN, right = Number.NaN, bottom = Number.NaN, left = Number.NaN] =
      insetValues;
    if ([top, right, bottom, left].some((inset) => Number.isNaN(inset))) return null;
    return {
      left: rect.left + Number.parseFloat(own.borderLeftWidth) + left,
      top: rect.top + Number.parseFloat(own.borderTopWidth) + top,
      right: rect.right - Number.parseFloat(own.borderRightWidth) - right,
      bottom: rect.bottom - Number.parseFloat(own.borderBottomWidth) - bottom,
    };
  }

  /**
   * The area that takes a tap: the control, any pseudo-element that extends it invisibly, and the
   * label around a checkbox or radio.
   */
  function faceBounds(element: Element, style: CSSStyleDeclaration): Bounds {
    const rect = element.getBoundingClientRect();
    // A fill clipped to the padding box leaves a transparent border undrawn: the border is room
    // the control takes, usually to be easier to tap, and no part of the face a person sees.
    const fills = style.backgroundClip === 'border-box' && colorOf(style.backgroundColor)[3] > 0;
    const hidden = (width: string, lineStyle: string, color: string): number =>
      !fills && (lineStyle === 'none' || colorOf(color)[3] === 0) ? Number.parseFloat(width) : 0;
    return {
      left: rect.left + hidden(style.borderLeftWidth, style.borderLeftStyle, style.borderLeftColor),
      top: rect.top + hidden(style.borderTopWidth, style.borderTopStyle, style.borderTopColor),
      right:
        rect.right - hidden(style.borderRightWidth, style.borderRightStyle, style.borderRightColor),
      bottom:
        rect.bottom -
        hidden(style.borderBottomWidth, style.borderBottomStyle, style.borderBottomColor),
    };
  }

  function hitBounds(element: Element): Bounds {
    let bounds = union(null, element.getBoundingClientRect());
    for (const pseudo of ['::before', '::after'] as const) {
      if (getComputedStyle(element, pseudo).pointerEvents === 'none') continue;
      const extension = pseudoBounds(element, pseudo);
      if (extension === null) continue;
      bounds = {
        left: Math.min(bounds.left, extension.left),
        top: Math.min(bounds.top, extension.top),
        right: Math.max(bounds.right, extension.right),
        bottom: Math.max(bounds.bottom, extension.bottom),
      };
    }
    if (element instanceof HTMLInputElement) {
      for (const label of element.labels ?? []) {
        if (isShown(label)) bounds = union(bounds, label.getBoundingClientRect());
      }
    }
    return bounds;
  }

  /** Whether a point lies outside the visible box of a region around the element that scrolls. */
  function scrolledOutOfView(element: Element, x: number, y: number): boolean {
    for (let node = element.parentElement; node !== null; node = node.parentElement) {
      const style = getComputedStyle(node);
      const scrollsX = style.overflowX === 'auto' || style.overflowX === 'scroll';
      const scrollsY = style.overflowY === 'auto' || style.overflowY === 'scroll';
      if (scrollsX || scrollsY) {
        const rect = node.getBoundingClientRect();
        const left = rect.left + node.clientLeft;
        const top = rect.top + node.clientTop;
        if (scrollsX && (x < left || x >= left + node.clientWidth)) return true;
        if (scrollsY && (y < top || y >= top + node.clientHeight)) return true;
      }
      // A fixed box sits on the viewport: what holds it in the tree scrolls nothing of it.
      if (style.position === 'fixed') return false;
    }
    return false;
  }

  /**
   * The sides on which a tap half the touch minimum from the control's center does not reach it,
   * each with what the tap reaches instead; `null` when the control could not be asked. The box
   * `hitBounds` reads is what the styles claim. This asks the browser what a finger gets, so a
   * hit area clipped by a parent, painted over by the next row, or cut by a bar shows up here.
   */
  function unreachedSides(element: Element): string[] | null {
    if (!window.matchMedia('(pointer: coarse)').matches) return null;
    if (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') {
      return null;
    }
    const own = element.getBoundingClientRect();
    const centerX = own.left + own.width / 2;
    const centerY = own.top + own.height / 2;
    const reaches = (x: number, y: number): boolean => {
      const top = document.elementFromPoint(x, y);
      if (top === null) return false;
      if (top === element || element.contains(top)) return true;
      // A label is part of the checkbox or radio it names.
      return top.closest('label')?.contains(element) === true;
    };
    // A control covered at its center is covered whole, which the covering check reports.
    if (!reaches(centerX, centerY)) return null;
    // A 44 pixel hit area ends 22 pixels from the center and its far edge is exclusive, so the
    // probe sits half a pixel inside it. Chromium answers the neighbor within about three quarters
    // of a pixel of a shared edge, so a control whose own box reaches that far is asked one pixel
    // inside its edge instead.
    const reach = 21.5;
    const along = (halfExtent: number): number =>
      halfExtent >= 22 ? Math.min(reach, halfExtent - 1) : reach;
    const reachX = along(own.width / 2);
    const reachY = along(own.height / 2);
    const sides: [string, number, number][] = [
      ['left', centerX - reachX, centerY],
      ['right', centerX + reachX, centerY],
      ['above', centerX, centerY - reachY],
      ['below', centerX, centerY + reachY],
    ];
    const short: string[] = [];
    let asked = 0;
    for (const [side, x, y] of sides) {
      if (x < 0 || y < 0 || x >= viewportWidth || y >= window.innerHeight) continue;
      // What is scrolled out of a region's visible box cannot be tapped at all; a swipe brings it back.
      if (scrolledOutOfView(element, x, y)) continue;
      asked += 1;
      if (reaches(x, y)) continue;
      const top = document.elementFromPoint(x, y);
      if (top === null) continue;
      // Compact neighbors overlap their hit areas by design: a point outside this control's own box
      // that reaches another control is that control's tap. Inside the box, it is a neighbor
      // covering this control's face.
      const insideOwnBox = x >= own.left && x < own.right && y >= own.top && y < own.bottom;
      const neighbor = top.closest(CONTROL_SELECTOR);
      if (
        !insideOwnBox &&
        neighbor !== null &&
        !neighbor.contains(element) &&
        !element.contains(neighbor)
      ) {
        continue;
      }
      // A fixed or stuck surface (a composer, a docked bar) covers content that scrolls under it,
      // which the covering check owns.
      let pinned = false;
      for (let node: Element | null = top; node !== null && node !== document.body;) {
        const position = getComputedStyle(node).position;
        if ((position === 'fixed' || position === 'sticky') && !node.contains(element)) {
          pinned = true;
          break;
        }
        node = node.parentElement;
      }
      if (pinned) continue;
      short.push(`${side} (reaches ${nameOf(top)})`);
    }
    return asked === 0 ? null : short;
  }

  const parents = new Map<Element, number>();

  /** A number shared by the controls of one parent, so the audit can tell which sit in one row. */
  function parentOf(element: Element): number {
    const parent = element.parentElement ?? element;
    const known = parents.get(parent);
    if (known !== undefined) return known;
    parents.set(parent, parents.size);
    return parents.size - 1;
  }

  function controlKind(element: Element): GeometryFacts['controls'][number]['kind'] {
    const tag = element.tagName;
    if (tag === 'INPUT') {
      const type = element.getAttribute('type') ?? 'text';
      return type === 'checkbox' || type === 'radio' ? 'other' : 'field';
    }
    if (tag === 'SELECT' || tag === 'TEXTAREA') return 'field';
    // A button that opens a list of values is a select drawn by hand. One that opens a menu or a
    // dialog (`aria-haspopup` of `menu`, `true` or `dialog`) is a button, and is held to a
    // button's sizes.
    if (
      element.getAttribute('aria-haspopup') === 'listbox' ||
      element.getAttribute('role') === 'combobox'
    ) {
      return 'field';
    }
    if (tag === 'BUTTON' || element.getAttribute('role') === 'button') return 'button';
    if (tag === 'A') return element.className.includes('button') ? 'button' : 'link';
    return 'other';
  }

  function controls(): GeometryFacts['controls'][number][] {
    const found: GeometryFacts['controls'][number][] = [];
    for (const element of document.querySelectorAll(CONTROL_SELECTOR)) {
      if (!isShown(element)) continue;
      const layout = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const face = faceBounds(element, style);
      const rect = {
        left: face.left,
        top: face.top,
        right: face.right,
        bottom: face.bottom,
        width: face.right - face.left,
        height: face.bottom - face.top,
      };
      // A label cut off with an ellipsis still measures its full length, so keep what the control shows.
      const whole = contentBounds(element);
      const content =
        whole === null
          ? null
          : {
              left: Math.max(whole.left, rect.left),
              top: Math.max(whole.top, rect.top),
              right: Math.min(whole.right, rect.right),
              bottom: Math.min(whole.bottom, rect.bottom),
            };
      const parent = element.parentElement;
      const parentStyle = parent === null ? null : getComputedStyle(parent);
      const available =
        parent === null || parentStyle === null
          ? viewportWidth
          : parent.clientWidth -
            Number.parseFloat(parentStyle.paddingLeft) -
            Number.parseFloat(parentStyle.paddingRight);
      const hit = hitBounds(element);
      found.push({
        name: nameOf(element),
        kind: controlKind(element),
        text: sampleOf(
          textNodes(element, true)
            .map((node) => node.data)
            .join(' '),
        ),
        accessibleLabel: element.getAttribute('aria-label') ?? element.getAttribute('title') ?? '',
        hasIcon: element.querySelector('svg, img') !== null,
        inline: style.display === 'inline',
        lineAction: element.matches('.chat-message-line .chat-message-action-button'),
        variant: controlModifier(element, 'variant') ?? '',
        layout: boxOf(union(null, layout)),
        rect: {
          x: half(rect.left),
          y: half(rect.top),
          width: half(rect.width),
          height: half(rect.height),
        },
        content:
          content === null
            ? null
            : {
                x: half(content.left),
                y: half(content.top),
                width: half(content.right - content.left),
                height: half(content.bottom - content.top),
              },
        fontSize: Number.parseFloat(style.fontSize),
        boxed:
          colorOf(style.backgroundColor)[3] > 0 ||
          (Number.parseFloat(style.borderTopWidth) > 0 &&
            style.borderTopStyle !== 'none' &&
            colorOf(style.borderTopColor)[3] > 0),
        labelRuns: textNodes(element, true).length,
        hit: boxOf(hit),
        extendedHitArea:
          hit.left < layout.left ||
          hit.top < layout.top ||
          hit.right > layout.right ||
          hit.bottom > layout.bottom,
        unreached: unreachedSides(element),
        parent: parentOf(element),
        // Filling a container that hugs it is not stretching, so it must also span half the viewport.
        fullWidth: rect.width >= available - 1 && rect.width >= viewportWidth / 2,
      });
    }
    return found;
  }

  function textStyles(): GeometryFacts['textStyles'][number][] {
    const styles = new Map<
      string,
      {
        -readonly [
          Key in keyof GeometryFacts['textStyles'][number]
        ]: GeometryFacts['textStyles'][number][Key];
      }
    >();
    for (const node of textNodes(document.body, true)) {
      const parent = node.parentElement;
      if (parent === null) continue;
      const style = getComputedStyle(parent);
      const fontSize = Number.parseFloat(style.fontSize);
      const lineHeight = style.lineHeight === 'normal' ? null : Number.parseFloat(style.lineHeight);
      const fontWeight = Number.parseInt(style.fontWeight, 10);
      const tops = new Set(rectsOf(node).map((rect) => Math.round(rect.top / (fontSize / 2))));
      const key = `${fontSize}|${lineHeight ?? 'normal'}|${fontWeight}`;
      const known = styles.get(key);
      if (known === undefined) {
        styles.set(key, {
          fontSize,
          lineHeight,
          fontWeight,
          count: 1,
          multiline: tops.size > 1,
          sample: sampleOf(node.data),
        });
      } else {
        known.count += 1;
        known.multiline ||= tops.size > 1;
      }
    }
    return [...styles.values()];
  }

  function borders(): GeometryFacts['borders'][number][] {
    const found = new Map<
      string,
      {
        name: string;
        width: number;
        style: string;
        contrast: number;
        interactive: boolean;
        count: number;
      }
    >();
    for (const element of document.body.querySelectorAll('*')) {
      if (SKIPPED_TAGS.has(element.tagName) || element.closest('svg') !== null) continue;
      const style = getComputedStyle(element);
      const sides = [
        [style.borderTopWidth, style.borderTopStyle, style.borderTopColor],
        [style.borderRightWidth, style.borderRightStyle, style.borderRightColor],
        [style.borderBottomWidth, style.borderBottomStyle, style.borderBottomColor],
        [style.borderLeftWidth, style.borderLeftStyle, style.borderLeftColor],
      ] as const;
      let width = 0;
      let line = 'solid';
      let color: [number, number, number, number] | null = null;
      for (const [sideWidth, sideStyle, sideColor] of sides) {
        const pixels = Number.parseFloat(sideWidth);
        if (sideStyle === 'none' || sideStyle === 'hidden' || pixels <= width) continue;
        const resolved = colorOf(sideColor);
        if (resolved[3] === 0) continue;
        width = pixels;
        line = sideStyle;
        color = resolved;
      }
      if (color === null || !isShown(element)) continue;
      const drawn = over(color, surfaceOf(element));
      const ratio = contrast(drawn, surfaceOf(element.parentElement));
      const name = nameOf(element);
      const key = `${name}|${width}|${line}|${ratio}`;
      const known = found.get(key);
      if (known === undefined) {
        found.set(key, {
          name,
          width,
          style: line,
          contrast: ratio,
          // A short box around a field is that field's boundary, as a composer's frame is.
          interactive:
            element.matches(CONTROL_SELECTOR) ||
            (element.getBoundingClientRect().height <= 240 &&
              element.querySelector(FIELD_SELECTOR) !== null),
          count: 1,
        });
      } else {
        known.count += 1;
      }
    }
    return [...found.values()];
  }

  /** Where each block of text starts, counted by left edge. */
  function edges(): GeometryFacts['edges'][number][] {
    const found = new Map<number, { x: number; count: number; samples: string[] }>();
    for (const element of document.body.querySelectorAll('*')) {
      if (SKIPPED_TAGS.has(element.tagName) || element.closest('svg') !== null) continue;
      if (textNodes(element, false).length === 0 || !isShown(element)) continue;
      if (element.closest(CONTROL_SELECTOR) !== null) continue;
      const style = getComputedStyle(element);
      if (style.textAlign !== 'start' && style.textAlign !== 'left') continue;
      const parent = element.parentElement;
      const continuesLine =
        style.display.startsWith('inline') &&
        parent !== null &&
        (textNodes(parent, false).length > 0 || element.previousElementSibling !== null);
      if (continuesLine) continue;
      const [first] = rectsOf(element);
      if (first === undefined) continue;
      const x = half(first.left);
      const known = found.get(x);
      if (known === undefined) found.set(x, { x, count: 1, samples: [nameOf(element)] });
      else {
        known.count += 1;
        if (known.samples.length < 2 && !known.samples.includes(nameOf(element))) {
          known.samples.push(nameOf(element));
        }
      }
    }
    return [...found.values()];
  }

  /** The gaps between the children of every container that stacks three or more of them. */
  function stacks(): GeometryFacts['stacks'][number][] {
    const found: GeometryFacts['stacks'][number][] = [];
    // Lists, quotations, code and tables indent or fill on purpose, so they set no edge of their own.
    const OWN_EDGE_TAGS = new Set(['UL', 'OL', 'DL', 'BLOCKQUOTE', 'PRE', 'TABLE', 'HR']);
    const distinct = (values: number[]): number[] =>
      [...new Set(values)].toSorted((left, right) => left - right);
    for (const element of document.body.querySelectorAll('*')) {
      if (element.children.length < 3 || element.closest('svg') !== null) continue;
      const children = [...element.children].filter((child) => {
        const position = getComputedStyle(child).position;
        return position !== 'absolute' && position !== 'fixed' && isShown(child);
      });
      if (children.length < 3) continue;
      const gaps: number[] = [];
      let stacked = true;
      for (const [index, child] of children.entries()) {
        const next = children[index + 1];
        if (next === undefined) break;
        const gap = next.getBoundingClientRect().top - child.getBoundingClientRect().bottom;
        if (gap < -0.5) {
          stacked = false;
          break;
        }
        gaps.push(half(Math.max(gap, 0)));
      }
      if (!stacked || gaps.every((gap) => gap === 0)) continue;
      const names = new Set(children.map((child) => nameOf(child)));
      const style = getComputedStyle(element);
      // A container that centers or end-aligns its children gives each its own edge by design.
      const startAligned =
        !['center', 'end', 'flex-end'].includes(style.alignItems) &&
        !['center', 'end', 'flex-end'].includes(style.justifyItems);
      const lefts: number[] = [];
      const rights: number[] = [];
      const box = element.getBoundingClientRect();
      const width = box.width;
      const start =
        box.left + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft);
      const end =
        box.right -
        Number.parseFloat(style.borderRightWidth) -
        Number.parseFloat(style.paddingRight);
      for (const child of children) {
        if (OWN_EDGE_TAGS.has(child.tagName)) continue;
        const childStyle = getComputedStyle(child);
        if (childStyle.textAlign !== 'start' && childStyle.textAlign !== 'left') continue;
        if (!startAligned || ['center', 'end', 'flex-end'].includes(childStyle.alignSelf)) continue;
        const rect = child.getBoundingClientRect();
        // A child pushed away from the leading edge with no more room after it is centered or
        // end-aligned (a sent message, a date divider), which is a placement and not an edge.
        const before = rect.left - start;
        if (before > 1 && end - rect.right <= before) continue;
        const content = contentBounds(child);
        if (content !== null) lefts.push(half(content.left));
        const boxed =
          colorOf(childStyle.backgroundColor)[3] > 0 ||
          (Number.parseFloat(childStyle.borderRightWidth) > 0 &&
            childStyle.borderRightStyle !== 'none' &&
            colorOf(childStyle.borderRightColor)[3] > 0);
        if (boxed && rect.width >= width * 0.4) rights.push(half(rect.right));
      }
      found.push({
        name: nameOf(element),
        uniformChildren: names.size === 1,
        gaps,
        lefts: distinct(lefts),
        rights: distinct(rights),
      });
    }
    return found;
  }

  /** Wide, short rows whose content starts well inside their leading edge, each naming the row around it. */
  function leadingSpace(): GeometryFacts['leadingSpace'][number][] {
    const outlet = document.querySelector('main') ?? document.body;
    const outletWidth = outlet.getBoundingClientRect().width;
    const found: GeometryFacts['leadingSpace'][number][] = [];
    const visit = (element: Element, within: number | null): void => {
      if (!isShown(element) || element.closest('svg') !== null) return;
      let around = within;
      const rect = element.getBoundingClientRect();
      if (rect.width >= outletWidth * 0.6 && rect.height <= 240) {
        const content = contentBounds(element);
        const style = getComputedStyle(element);
        const start =
          rect.left +
          Number.parseFloat(style.borderLeftWidth) +
          Number.parseFloat(style.paddingLeft);
        const end =
          rect.right -
          Number.parseFloat(style.borderRightWidth) -
          Number.parseFloat(style.paddingRight);
        if (content !== null && content.left - start >= 24 && end > start) {
          found.push({
            name: nameOf(element),
            width: half(end - start),
            leading: half(content.left - start),
            trailing: half(Math.max(end - content.right, 0)),
            within,
            sample: sampleOf(
              textNodes(element, true)
                .map((node) => node.data)
                .join(' '),
            ),
          });
          around = found.length - 1;
        }
      }
      for (const child of element.children) visit(child, around);
    };
    visit(outlet, null);
    return found;
  }

  function intersection(first: Bounds, second: Bounds): { width: number; height: number } {
    return {
      width: Math.min(first.right, second.right) - Math.max(first.left, second.left),
      height: Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top),
    };
  }

  function labelOf(element: Element): string {
    const text = sampleOf(
      textNodes(element, true)
        .map((node) => node.data)
        .join(' '),
    );
    return text === ''
      ? (element.getAttribute('aria-label') ?? element.getAttribute('title') ?? '')
      : text;
  }

  /** The strips a scroll fade paints over the edge of its scroller: a gradient that takes no tap. */
  function fadeBands(): { owner: Element; bounds: Bounds }[] {
    const bands: { owner: Element; bounds: Bounds }[] = [];
    for (const element of document.body.querySelectorAll('*')) {
      for (const pseudo of ['::before', '::after'] as const) {
        const style = getComputedStyle(element, pseudo);
        if (style.content === 'none' || style.pointerEvents !== 'none') continue;
        if (!style.backgroundImage.includes('gradient') || Number.parseFloat(style.opacity) < 0.5) {
          continue;
        }
        if (style.position !== 'sticky' && style.position !== 'absolute') continue;
        if (!isShown(element)) continue;
        const rect = element.getBoundingClientRect();
        const blockSize = Number.parseFloat(style.height);
        const inlineSize = Number.parseFloat(style.width);
        // A band pinned to one edge covers that edge of what its owner shows.
        if (Number.parseFloat(style.bottom) === 0 && blockSize > 0 && blockSize < rect.height) {
          bands.push({
            owner: element,
            bounds: {
              left: rect.left,
              right: rect.right,
              top: rect.bottom - blockSize,
              bottom: rect.bottom,
            },
          });
        } else if (Number.parseFloat(style.top) === 0 && blockSize > 0 && blockSize < rect.height) {
          bands.push({
            owner: element,
            bounds: {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.top + blockSize,
            },
          });
        } else if (
          Number.parseFloat(style.right) === 0 &&
          inlineSize > 0 &&
          inlineSize < rect.width
        ) {
          bands.push({
            owner: element,
            bounds: {
              left: rect.right - inlineSize,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
            },
          });
        }
      }
    }
    return bands;
  }

  /** Whether an element sits in a region that has more content than it shows. */
  function insideScroller(element: Element): boolean {
    for (let node = element.parentElement; node !== null; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowY;
      if (
        (overflow === 'auto' || overflow === 'scroll') &&
        node.scrollHeight > node.clientHeight + 1
      ) {
        return true;
      }
    }
    return false;
  }

  /** Whether an element, or one around it, is stuck or fixed to the top of the viewport. */
  function pinnedToTop(element: Element): boolean {
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      const position = getComputedStyle(node).position;
      if (position !== 'sticky' && position !== 'fixed') continue;
      const rect = node.getBoundingClientRect();
      if (rect.top <= 1 && rect.bottom < window.innerHeight / 2) return true;
    }
    return false;
  }

  /** Controls partly under something else, controls under a fade, and controls drawn over text. */
  function overlaps(): GeometryFacts['overlaps'][number][] {
    const found: GeometryFacts['overlaps'][number][] = [];
    const viewportHeight = window.innerHeight;
    const shown = [...document.querySelectorAll(CONTROL_SELECTOR)].filter((element) =>
      isShown(element),
    );
    const related = (first: Element, second: Element): boolean =>
      first.contains(second) || second.contains(first);
    for (const element of shown) {
      const rect = element.getBoundingClientRect();
      const inset = Math.min(3, rect.width / 4, rect.height / 4);
      const points: [number, number][] = [
        [rect.left + rect.width / 2, rect.top + rect.height / 2],
        [rect.left + rect.width / 2, rect.top + inset],
        [rect.left + rect.width / 2, rect.bottom - inset],
        [rect.left + inset, rect.top + rect.height / 2],
        [rect.right - inset, rect.top + rect.height / 2],
      ];
      const inView = points.filter(
        ([x, y]) => x >= 0 && x < viewportWidth && y >= 0 && y < viewportHeight,
      );
      // A control cut by the edge of the viewport is scrolling, not covering, and so is one inside a
      // region that scrolls: what a bar hides there, a swipe reveals.
      if (inView.length < points.length || insideScroller(element)) continue;
      const covers = new Map<Element, number>();
      for (const [x, y] of inView) {
        const top = document.elementFromPoint(x, y);
        if (top === null || related(top, element)) continue;
        // A label is part of the control it names.
        if (top.closest('label')?.contains(element) === true) continue;
        // An adornment beside the control in one frame (a field's clear button) is part of it.
        if (top.parentElement === element.parentElement) continue;
        // Content scrolled under a bar pinned to the top is scrolling, not covering.
        if (pinnedToTop(top)) continue;
        covers.set(top, (covers.get(top) ?? 0) + 1);
      }
      const covered = [...covers.values()].reduce((sum, count) => sum + count, 0);
      // Wholly covered is behind a dialog or a sheet, which is meant; partly covered is the defect.
      if (covered === 0 || covered === inView.length) continue;
      const [cover] = [...covers.keys()];
      if (cover === undefined) continue;
      found.push({
        kind: 'covered',
        subject: nameOf(element),
        label: labelOf(element),
        by: nameOf(cover.closest(CONTROL_SELECTOR) ?? cover),
        amount: covered / inView.length,
      });
    }
    for (const band of fadeBands()) {
      for (const element of shown) {
        if (!band.owner.contains(element)) continue;
        const rect = element.getBoundingClientRect();
        const shared = intersection(band.bounds, union(null, rect));
        if (shared.width < 2 || shared.height < 2) continue;
        found.push({
          kind: 'faded',
          subject: nameOf(element),
          label: labelOf(element),
          by: nameOf(band.owner),
          amount: Math.min(shared.height / rect.height, 1),
        });
      }
    }
    // A control lifted out of the flow (a copy button on a code block) can land on the text beside it.
    const lifted = shown.filter((element) => {
      for (let node: Element | null = element, depth = 0; node !== null && depth < 3; depth += 1) {
        const position = getComputedStyle(node).position;
        if (position === 'absolute' || position === 'sticky') return true;
        node = node.parentElement;
      }
      return false;
    });
    if (lifted.length > 0) {
      // A line is what shows of it: the part a scroller or a clipping box cuts away is not text a
      // control can lie on (a step row scrolled under the edge of a transcript).
      const lines: { parent: Element; rect: DOMRect; visible: Bounds }[] = [];
      for (const node of textNodes(document.body, true)) {
        const parent = node.parentElement;
        if (parent === null) continue;
        for (const rect of rectsOf(node)) {
          let visible = union(null, rect);
          for (
            let ancestor = parent.parentElement;
            ancestor !== null;
            ancestor = ancestor.parentElement
          ) {
            const ancestorStyle = getComputedStyle(ancestor);
            const clips = ['hidden', 'clip', 'auto', 'scroll'];
            if (
              !clips.includes(ancestorStyle.overflowX) &&
              !clips.includes(ancestorStyle.overflowY)
            )
              continue;
            const box = ancestor.getBoundingClientRect();
            visible = {
              left: Math.max(visible.left, box.left + ancestor.clientLeft),
              top: Math.max(visible.top, box.top + ancestor.clientTop),
              right: Math.min(visible.right, box.left + ancestor.clientLeft + ancestor.clientWidth),
              bottom: Math.min(
                visible.bottom,
                box.top + ancestor.clientTop + ancestor.clientHeight,
              ),
            };
          }
          if (visible.right > visible.left && visible.bottom > visible.top) {
            lines.push({ parent, rect, visible });
          }
        }
      }
      for (const element of lifted) {
        const style = getComputedStyle(element);
        const boxed =
          colorOf(style.backgroundColor)[3] > 0 || Number.parseFloat(style.borderTopWidth) > 0;
        // What lies on the text is what the control draws: its box, or else its label and icon.
        const elementRect = element.getBoundingClientRect();
        const drawn = boxed ? paintedBox(element, elementRect, style) : contentBounds(element);
        if (drawn === null) continue;
        const rect = new DOMRect(
          drawn.left,
          drawn.top,
          drawn.right - drawn.left,
          drawn.bottom - drawn.top,
        );
        for (const line of lines) {
          if (related(element, line.parent)) continue;
          const shared = intersection(union(null, rect), line.visible);
          if (shared.width < 2 || shared.height < 2) continue;
          const x = Math.max(rect.left, line.visible.left) + shared.width / 2;
          const y = Math.max(rect.top, line.visible.top) + shared.height / 2;
          const top = document.elementFromPoint(x, y);
          if (top === null || !element.contains(top)) continue;
          found.push({
            kind: 'over-text',
            subject: nameOf(element),
            label: labelOf(element),
            by: nameOf(line.parent),
            amount: Math.min(shared.height / line.rect.height, 1),
          });
          break;
        }
      }
    }
    return found;
  }

  /** Boxes whose content has more room above it than below it. */
  function insets(): GeometryFacts['insets'][number][] {
    const SKIPPED = new Set(['TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'BODY', 'MAIN']);
    const found: GeometryFacts['insets'][number][] = [];
    for (const element of document.body.querySelectorAll('*')) {
      if (SKIPPED.has(element.tagName) || element.closest('svg') !== null) continue;
      if (element.closest(CONTROL_SELECTOR) !== null) continue;
      const style = getComputedStyle(element);
      const bordered =
        Number.parseFloat(style.borderTopWidth) > 0 &&
        style.borderTopStyle !== 'none' &&
        colorOf(style.borderTopColor)[3] > 0 &&
        Number.parseFloat(style.borderBottomWidth) > 0 &&
        style.borderBottomStyle !== 'none';
      if (!bordered && colorOf(style.backgroundColor)[3] === 0) continue;
      if (!isShown(element)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.height > 400 || rect.height < 24) continue;
      // What a scroller shows is a window on its content, not its padding.
      if (element.scrollHeight > element.clientHeight + 1) continue;
      let content = contentBounds(element);
      // A field or a control that draws a box is content too, whatever text it holds.
      for (const control of element.querySelectorAll(CONTROL_SELECTOR)) {
        if (!isShown(control)) continue;
        const controlStyle = getComputedStyle(control);
        if (
          control.matches(FIELD_SELECTOR) ||
          colorOf(controlStyle.backgroundColor)[3] > 0 ||
          Number.parseFloat(controlStyle.borderTopWidth) > 0
        ) {
          content = union(content, control.getBoundingClientRect());
        }
      }
      if (content === null) continue;
      const above = content.top - rect.top - Number.parseFloat(style.borderTopWidth);
      const below = rect.bottom - Number.parseFloat(style.borderBottomWidth) - content.bottom;
      if (above < 0 || below < 0 || above - below < 2) continue;
      found.push({
        name: nameOf(element),
        above: half(above),
        below: half(below),
        sample: sampleOf(
          textNodes(element, true)
            .map((node) => node.data)
            .join(' '),
        ),
      });
    }
    return found;
  }

  /** How much of the viewport sits above and below the region that scrolls the page's content. */
  function chrome(): GeometryFacts['chrome'] {
    const viewportHeight = window.innerHeight;
    const scrollers = [...document.body.querySelectorAll('*')].filter((element) => {
      const overflow = getComputedStyle(element).overflowY;
      if (overflow !== 'auto' && overflow !== 'scroll') return false;
      const rect = element.getBoundingClientRect();
      return (
        isShown(element) && rect.width >= viewportWidth * 0.6 && rect.height >= viewportHeight * 0.2
      );
    });
    // The innermost one is the region the content scrolls in; everything around it stays put.
    const innermost = scrollers.filter(
      (element) => !scrollers.some((other) => other !== element && element.contains(other)),
    );
    const [region] = innermost.toSorted(
      (left, right) =>
        right.getBoundingClientRect().height * right.getBoundingClientRect().width -
        left.getBoundingClientRect().height * left.getBoundingClientRect().width,
    );
    if (region === undefined) return null;
    const rect = region.getBoundingClientRect();
    return {
      name: nameOf(region),
      top: half(Math.max(rect.top, 0)),
      bottom: half(Math.max(viewportHeight - rect.bottom, 0)),
    };
  }

  return {
    viewport: { width: viewportWidth, height: window.innerHeight },
    pointerCoarse: window.matchMedia('(pointer: coarse)').matches,
    spaceScale: spaceScale(),
    controls: controls(),
    textStyles: textStyles(),
    borders: borders(),
    edges: edges(),
    stacks: stacks(),
    leadingSpace: leadingSpace(),
    overlaps: overlaps(),
    insets: insets(),
    chrome: chrome(),
  };
}

/** Measures the page as it stands. */
export async function measureGeometry(page: Page): Promise<GeometryFacts> {
  return page.evaluate(collectGeometryFacts);
}
