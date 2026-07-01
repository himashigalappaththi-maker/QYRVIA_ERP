---
name: Hospitality Precision
colors:
  surface: '#f8f9fa'
  surface-dim: '#d9dadb'
  surface-bright: '#f8f9fa'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f3f4f5'
  surface-container: '#edeeef'
  surface-container-high: '#e7e8e9'
  surface-container-highest: '#e1e3e4'
  on-surface: '#191c1d'
  on-surface-variant: '#4f4539'
  inverse-surface: '#2e3132'
  inverse-on-surface: '#f0f1f2'
  outline: '#807568'
  outline-variant: '#d2c4b4'
  surface-tint: '#7a581f'
  primary: '#7a581f'
  on-primary: '#ffffff'
  primary-container: '#b38b4d'
  on-primary-container: '#3c2600'
  inverse-primary: '#ecbf7c'
  secondary: '#565f69'
  on-secondary: '#ffffff'
  secondary-container: '#dae3ef'
  on-secondary-container: '#5c656f'
  tertiary: '#555f6e'
  on-tertiary: '#ffffff'
  tertiary-container: '#8892a3'
  on-tertiary-container: '#212b39'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#ffddaf'
  primary-fixed-dim: '#ecbf7c'
  on-primary-fixed: '#281800'
  on-primary-fixed-variant: '#5f4108'
  secondary-fixed: '#dae3ef'
  secondary-fixed-dim: '#bec7d3'
  on-secondary-fixed: '#141c25'
  on-secondary-fixed-variant: '#3f4851'
  tertiary-fixed: '#d9e3f5'
  tertiary-fixed-dim: '#bdc7d9'
  on-tertiary-fixed: '#121c29'
  on-tertiary-fixed-variant: '#3e4756'
  background: '#f8f9fa'
  on-background: '#191c1d'
  surface-variant: '#e1e3e4'
typography:
  headline-lg:
    fontFamily: Hanken Grotesk
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Hanken Grotesk
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: Hanken Grotesk
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-lg:
    fontFamily: Hanken Grotesk
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Hanken Grotesk
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-lg:
    fontFamily: Hanken Grotesk
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.05em
  label-md:
    fontFamily: Hanken Grotesk
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 14px
  headline-lg-mobile:
    fontFamily: Hanken Grotesk
    fontSize: 28px
    fontWeight: '700'
    lineHeight: 36px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  base: 4px
  xs: 8px
  sm: 16px
  md: 24px
  lg: 40px
  xl: 64px
  gutter: 24px
  margin-mobile: 16px
  margin-desktop: 32px
---

## Brand & Style

This design system targets high-end hospitality management and ERP sectors. The brand personality is **authoritative, meticulous, and luxurious**, evoking the seamless service of a five-star establishment. 

The visual style is **Corporate / Modern** with a focus on high-precision data visualization and management. It utilizes a refined editorial layout, prioritizing clarity and institutional trust. Every element is designed to feel intentional and premium, moving away from generic SaaS aesthetics toward a bespoke, industry-specific interface that reflects the gold-standard of hospitality service.

## Colors

The palette is derived directly from the QYRVIA visual identity, emphasizing architectural stability and luxury.

- **Primary (Gold/Bronze):** Used for key actions, brand highlights, and primary navigation states. It represents the "premium" tier of service.
- **Secondary (Charcoal):** Used for typography, headers, and structural elements. It provides the "grounding" weight necessary for an ERP system.
- **Neutral Palette:** A sophisticated range of cool grays and off-whites replaces pure whites to reduce eye strain during long-form data management while maintaining a crisp, clean environment.
- **Status Colors:** Functional indicators are muted to match the luxury aesthetic. "Clean" utilizes a sage green, while "Dirty" uses a burnt terracotta, ensuring they are visible but not jarring within the gold/charcoal framework.

## Typography

The design system exclusively utilizes **Hanken Grotesk** to provide a sharp, contemporary, and highly legible experience across all touchpoints. 

- **Headlines:** Use tighter letter-spacing and heavier weights to establish a strong hierarchy.
- **Body Text:** Optimized for density and readability in data-heavy tables and property management views.
- **Labels:** Small-scale labels often utilize uppercase styling with increased tracking to differentiate them from interactive body text, mimicking the signage found in luxury hotels.

## Layout & Spacing

This design system employs a **Fixed Grid** philosophy for desktop dashboards to ensure data consistency, transitioning to a fluid model for tablet and mobile devices.

- **Grid Model:** A 12-column grid is used for desktop (max-width: 1440px) with 24px gutters.
- **Rhythm:** A 4px baseline grid governs all vertical rhythm.
- **Density:** The system prioritizes "Information Luxury"—avoiding clutter by using generous 40px (lg) margins between major sections, while maintaining 8px (xs) or 16px (sm) spacing within functional groups (like input fields or list items) to ensure operational efficiency.

## Elevation & Depth

Hierarchy is established through **Tonal Layers** and **Low-Contrast Outlines** rather than aggressive shadows.

- **Surfaces:** Use subtle shifts in neutral values (e.g., a slightly darker gray background with white cards) to define depth.
- **Outlines:** Primary containers use 1px borders in a soft neutral tone.
- **Interactive Depth:** Only the most critical floating elements (modals, dropdowns) use "Ambient Shadows"—diffused, low-opacity (8-10%) shadows with a slight secondary (charcoal) tint to keep the elevation feeling grounded and architectural.

## Shapes

The design system adopts a **Soft (1)** shape language. The 4px (0.25rem) base radius provides a modern touch without feeling overly "bubbly" or casual. This structural rigidity reinforces the professional nature of ERP software, while the slight rounding prevents the UI from feeling dated or overly harsh. 

- **Buttons & Inputs:** 4px radius.
- **Large Cards:** 8px (rounded-lg) radius.
- **Status Badges:** 4px radius for a consistent, "tab-like" appearance.

## Components

- **Buttons:** Primary buttons use the Gold/Bronze background with White text. Secondary buttons use a Charcoal outline with Charcoal text. Use a 1px border weight.
- **Chips / Status Badges:** Use a light-tinted background (10% opacity) of the status color with the full-strength status color for the text and a subtle 1px border.
- **Input Fields:** Utilize a white background with a 1px Charcoal-tinted border. On focus, the border transitions to the Primary Gold.
- **Cards:** Cards should be flat with a 1px neutral border. No shadow is used for standard cards; only "Active" or "Hovered" cards may gain a soft ambient shadow.
- **Data Tables:** High-density rows with 1px horizontal dividers. Header rows should use the Secondary Charcoal background with White labels for high-contrast structural definition.
- **Navigation:** Vertical sidebars use the Secondary Charcoal background to provide a sophisticated frame for the primary content area.