---
id: shell/schema-forms
package: "@elements/shell-schema-forms"
plane: system
category: shell
version: 0.1.0
variationGroup: null
variationAxis: null
summary: Renders a validated form from the same zod schema the server mutation validates with — one schema on both sides, no drift.
provides: [SchemaForm, SchemaFormProps, FieldConfig]
requiresElements: []
requiresConfig: []
claims:
  - "Invalid input is rejected with a visible message next to the offending field, before anything is sent to the server."
whenToUse: "Any create/edit form whose shape is already a zod schema on a mutation."
whenNotToUse: "Multi-step wizards or highly custom layouts — write those bespoke on top of the same schemas."
---

## Purpose

One form discipline: the zod schema that guards the server mutation also renders the client form and produces its validation messages. Text, number, boolean and enum fields are inferred; labels and options can be overridden per field.

## Behavior

Submitting a form with a missing or invalid value never silently does nothing: the offending field shows a message explaining what is wrong, and nothing is sent until every field passes. A successful submission clears the form (or hands off to the caller); a server rejection surfaces its message visibly on the form.

## Configuration

Per-field label, placeholder, and select options via the `fields` prop; initial values for edit forms.

## Wiring

The vertical passes the shared zod schema (defined bespoke, used by the mutation via intake factories) and an `onSubmit` that calls the mutation — keeping the control-to-procedure edge in derivable bespoke code.

## Variations & alternatives

None. A dense inline-edit grid would be a separate shell element, not a variation of this.

## Limits

Flat object schemas only (no nesting or arrays) in v1. Date/file inputs not yet inferred.
