import { useState, type JSX, type FormEvent } from "react";
import {
  ZodBoolean,
  ZodDefault,
  ZodEnum,
  ZodNumber,
  ZodOptional,
  ZodString,
  type ZodObject,
  type ZodRawShape,
  type ZodType,
} from "zod";

export interface FieldConfig {
  label?: string;
  placeholder?: string;
  /** Render as a select with these options (overrides inference). */
  options?: string[];
  /** Input type override for string fields (e.g. "password" for credentials). */
  inputType?: "password";
}

export interface SchemaFormProps<S extends ZodRawShape> {
  schema: ZodObject<S>;
  onSubmit: (values: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
  submitLabel: string;
  fields?: Record<string, FieldConfig>;
  initialValues?: Record<string, unknown>;
  /** Called after a successful submit (e.g. to clear or navigate). */
  onSuccess?: () => void;
}

function unwrap(t: ZodType): { inner: ZodType; optional: boolean } {
  let inner = t;
  let optional = false;
  for (;;) {
    if (inner instanceof ZodOptional) {
      optional = true;
      inner = inner.unwrap() as ZodType;
    } else if (inner instanceof ZodDefault) {
      optional = true;
      inner = (inner as ZodDefault<ZodType>).unwrap() as ZodType;
    } else {
      return { inner, optional };
    }
  }
}

/**
 * Renders a typed form from the SAME zod schema the server mutation validates
 * with — one schema, both sides, no drift. Field errors come from the schema.
 */
export function SchemaForm<S extends ZodRawShape>(props: SchemaFormProps<S>): JSX.Element {
  const [values, setValues] = useState<Record<string, unknown>>(props.initialValues ?? {});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const shape = props.schema.shape;

  function setValue(name: string, value: unknown): void {
    setValues((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setFormError(null);
    const parsed = props.schema.safeParse(values);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "");
        if (!errs[key]) errs[key] = issue.message;
      }
      setFieldErrors(errs);
      return;
    }
    setFieldErrors({});
    setBusy(true);
    const result = await props.onSubmit(parsed.data as Record<string, unknown>);
    setBusy(false);
    if (!result.ok) {
      setFormError(result.error ?? "Something went wrong");
      return;
    }
    setValues(props.initialValues ?? {});
    props.onSuccess?.();
  }

  return (
    <form className="stacked" onSubmit={handleSubmit}>
      {Object.entries(shape).map(([name, fieldSchema]) => {
        const config = props.fields?.[name] ?? {};
        const label = config.label ?? name;
        const { inner } = unwrap(fieldSchema as ZodType);
        const error = fieldErrors[name];
        const current = values[name];

        let control: JSX.Element;
        if (config.options || inner instanceof ZodEnum) {
          const options = config.options ?? (inner as ZodEnum<Record<string, string>>).options;
          control = (
            <select
              value={(current as string) ?? ""}
              onChange={(e) => setValue(name, e.target.value)}
            >
              <option value="" disabled>
                {config.placeholder ?? `Select ${label}`}
              </option>
              {(options as string[]).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          );
        } else if (inner instanceof ZodNumber) {
          control = (
            <input
              type="number"
              step="any"
              value={current === undefined || current === null ? "" : String(current)}
              placeholder={config.placeholder}
              onChange={(e) =>
                setValue(name, e.target.value === "" ? undefined : Number(e.target.value))
              }
            />
          );
        } else if (inner instanceof ZodBoolean) {
          control = (
            <input
              type="checkbox"
              checked={Boolean(current)}
              onChange={(e) => setValue(name, e.target.checked)}
            />
          );
        } else if (inner instanceof ZodString) {
          control = (
            <input
              type={config.inputType ?? "text"}
              value={(current as string) ?? ""}
              placeholder={config.placeholder}
              onChange={(e) => setValue(name, e.target.value === "" ? undefined : e.target.value)}
            />
          );
        } else {
          control = (
            <input
              type="text"
              value={(current as string) ?? ""}
              onChange={(e) => setValue(name, e.target.value)}
            />
          );
        }

        return (
          <label key={name}>
            {label}
            {control}
            {error ? <p className="field-error">{error}</p> : null}
          </label>
        );
      })}
      {formError ? (
        <p role="alert" className="form-error">
          {formError}
        </p>
      ) : null}
      <button type="submit" disabled={busy}>
        {busy ? "Saving…" : props.submitLabel}
      </button>
    </form>
  );
}
