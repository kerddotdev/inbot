import { Button, IconButton, inputClasses } from "../../components/ui";
import { SecretInput } from "../../components/SecretInput";
import { isFieldName, type AddedField } from "./forms";

export function AddedFields({
  fields,
  onChange,
  label = "New fields",
}: {
  fields: readonly AddedField[];
  onChange: (fields: readonly AddedField[]) => void;
  label?: string;
}) {
  const update = (id: number, patch: Partial<AddedField>) =>
    onChange(fields.map((field) => (field.id === id ? { ...field, ...patch } : field)));
  return (
    <div className="grid gap-2">
      {fields.map((field, index) => (
        <div key={field.id} className="grid grid-cols-[120px_1fr_auto] items-start gap-2">
          <input
            aria-label={`${label} ${index + 1} name`}
            className={`${inputClasses} font-mono`}
            value={field.name}
            placeholder="password"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={field.name !== "" && !isFieldName(field.name.trim())}
            onChange={(event) => update(field.id, { name: event.target.value })}
          />
          <SecretInput
            aria-label={`${label} ${index + 1} value`}
            value={field.value}
            onChange={(event) => update(field.id, { value: event.target.value })}
          />
          <IconButton
            icon="x-circle"
            label={`Remove ${label.toLowerCase()} ${index + 1}`}
            onClick={() => onChange(fields.filter((item) => item.id !== field.id))}
          />
        </div>
      ))}
      <div>
        <Button
          variant="quiet"
          icon="plus"
          onClick={() =>
            onChange([
              ...fields,
              { id: Math.max(0, ...fields.map((f) => f.id)) + 1, name: "", value: "" },
            ])
          }
        >
          Add field
        </Button>
      </div>
      <p className="text-xs text-ink2">
        Field names use lowercase letters, digits and underscores. The totp field accepts a setup
        key or an otpauth URI.
      </p>
    </div>
  );
}
