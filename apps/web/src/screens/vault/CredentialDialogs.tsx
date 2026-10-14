import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Credential } from "@inbot/contracts/src/vault.js";
import { api } from "../../api";
import { Dialog } from "../../components/Dialog";
import { Select } from "../../components/Select";
import { SecretInput } from "../../components/SecretInput";
import { Button, inputClasses, Segmented, Status } from "../../components/ui";
import { ErrorNotice } from "../../feedback";
import { inboxesQuery } from "../../queries";
import { AddedFields } from "./FieldInputs";
import {
  buildCreate,
  buildGenerate,
  buildUpdate,
  initialEditForm,
  invalidFieldNames,
  type AddedField,
  type EditForm,
} from "./forms";

const label = "mb-[7px] block font-semibold";

function useCredentialMutation<T, V>(mutationFn: (variables: V) => Promise<T>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => client.invalidateQueries({ queryKey: ["credentials"] }),
  });
}

function Actions({
  onCancel,
  busy,
  submit,
  disabled = false,
}: {
  onCancel: () => void;
  busy: boolean;
  submit: string;
  disabled?: boolean;
}) {
  return (
    <div className="mt-5 flex items-center justify-end gap-2.5">
      <Button variant="quiet" disabled={busy} onClick={onCancel}>
        Cancel
      </Button>
      <Button variant="primary" type="submit" disabled={busy || disabled}>
        {submit}
      </Button>
    </div>
  );
}

export function EditCredential({
  credential,
  onClose,
}: {
  credential: Credential;
  onClose: () => void;
}) {
  const [form, setForm] = useState<EditForm>(() => initialEditForm(credential));
  const save = useCredentialMutation((body: NonNullable<ReturnType<typeof buildUpdate>>) =>
    api.updateCredential(credential, body),
  );
  const update = buildUpdate(credential, form);
  const patch = (changes: Partial<EditForm>) => setForm((current) => ({ ...current, ...changes }));
  const toggleRemoved = (field: string) => {
    const removed = new Set(form.removed);
    if (!removed.delete(field)) removed.add(field);
    patch({ removed });
  };
  const replacing = (field: string) => form.replacements[field] !== undefined;
  const invalid = invalidFieldNames(form.added).length > 0 || form.name.trim() === "";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (update && !invalid && !save.isPending) save.mutate(update, { onSuccess: onClose });
  };
  return (
    <Dialog title="Edit credential" onClose={onClose} busy={save.isPending}>
      <form onSubmit={submit} aria-busy={save.isPending}>
        <fieldset disabled={save.isPending} className="grid gap-4">
          <label>
            <span className={label}>Name</span>
            <input
              className={inputClasses}
              value={form.name}
              maxLength={200}
              autoComplete="off"
              onChange={(event) => patch({ name: event.target.value })}
            />
          </label>
          <label>
            <span className={label}>URL</span>
            <input
              className={inputClasses}
              type="url"
              value={form.url}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://example.com/login"
              onChange={(event) => patch({ url: event.target.value })}
            />
          </label>
          <label>
            <span className={label}>Extra origins (one per line)</span>
            <textarea
              className={`${inputClasses} font-mono`}
              rows={2}
              value={form.origins}
              spellCheck={false}
              placeholder="https://accounts.example.com"
              onChange={(event) => patch({ origins: event.target.value })}
            />
          </label>
          <label>
            <span className={label}>Username</span>
            <input
              className={inputClasses}
              value={form.username}
              maxLength={320}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => patch({ username: event.target.value })}
            />
          </label>
          <fieldset className="min-w-0">
            <legend className={label}>Fields</legend>
            {credential.fields.length === 0 ? (
              <p className="text-ink2">This credential has no stored fields.</p>
            ) : (
              <ul className="mb-3">
                {credential.fields.map((field) => (
                  <li key={field} className="border-b border-line py-2 first:pt-0 last:border-b-0">
                    <div className="flex items-center gap-2">
                      <span className="flex-1 font-mono">{field}</span>
                      {form.removed.has(field) ? (
                        <Status tone="warn" icon="minus-circle">
                          Will be removed
                        </Status>
                      ) : null}
                      {!form.removed.has(field) ? (
                        <Button
                          variant="quiet"
                          aria-label={`${replacing(field) ? "Keep" : "Replace"} ${field}`}
                          onClick={() => {
                            const { [field]: _removed, ...rest } = form.replacements;
                            patch({
                              replacements: replacing(field) ? rest : { ...rest, [field]: "" },
                            });
                          }}
                        >
                          {replacing(field) ? "Keep current" : "Replace"}
                        </Button>
                      ) : null}
                      <Button
                        variant={form.removed.has(field) ? "quiet" : "danger"}
                        aria-label={`${form.removed.has(field) ? "Keep" : "Remove"} ${field}`}
                        onClick={() => toggleRemoved(field)}
                      >
                        {form.removed.has(field) ? "Undo" : "Remove"}
                      </Button>
                    </div>
                    {replacing(field) && !form.removed.has(field) ? (
                      <div className="mt-2">
                        <SecretInput
                          aria-label={`New value for ${field}`}
                          value={form.replacements[field] ?? ""}
                          placeholder="New value"
                          onChange={(event) =>
                            patch({
                              replacements: { ...form.replacements, [field]: event.target.value },
                            })
                          }
                        />
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <AddedFields fields={form.added} onChange={(added) => patch({ added })} />
          </fieldset>
          <ErrorNotice error={save.error} />
        </fieldset>
        <Actions
          onCancel={onClose}
          busy={save.isPending}
          submit={save.isPending ? "Saving..." : "Save changes"}
          disabled={update === undefined || invalid}
        />
      </form>
    </Dialog>
  );
}

export function GeneratePassword({
  credential,
  onClose,
  onReveal,
}: {
  credential: Credential;
  onClose: () => void;
  onReveal: () => void;
}) {
  const [field, setField] = useState("password");
  const [mode, setMode] = useState<"apple" | "random">("apple");
  const [length, setLength] = useState("");
  const [rules, setRules] = useState("");
  const generate = useCredentialMutation(() =>
    api.generateCredentialField(credential, buildGenerate({ field, mode, length, rules })),
  );
  const replaces = credential.fields.includes(field.trim() || "password");
  if (generate.isSuccess)
    return (
      <Dialog title="Password generated" onClose={onClose}>
        <p role="status" className="mb-5 text-ink2">
          The new value is stored in the {field.trim() || "password"} field. It is not shown unless
          you reveal it.
        </p>
        <div className="flex justify-end gap-2.5">
          <Button variant="quiet" onClick={onClose}>
            Done
          </Button>
          <Button
            variant="primary"
            icon="eye"
            onClick={() => {
              onReveal();
              onClose();
            }}
          >
            Reveal
          </Button>
        </div>
      </Dialog>
    );
  return (
    <Dialog title="Generate password" onClose={onClose} busy={generate.isPending}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!generate.isPending) generate.mutate(undefined);
        }}
        aria-busy={generate.isPending}
      >
        <fieldset disabled={generate.isPending} className="grid gap-4">
          <label>
            <span className={label}>Field</span>
            <input
              className={`${inputClasses} font-mono`}
              list="generate-fields"
              value={field}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setField(event.target.value)}
            />
            <datalist id="generate-fields">
              {credential.fields
                .filter((name) => name !== "totp")
                .map((name) => (
                  <option key={name} value={name} />
                ))}
            </datalist>
          </label>
          {replaces ? (
            <Status tone="warn" icon="alert">
              This replaces the current {field.trim() || "password"} value.
            </Status>
          ) : null}
          <fieldset className="min-w-0">
            <legend className={label}>Style</legend>
            <Segmented<"apple" | "random">
              name="generate-mode"
              value={mode}
              onChange={setMode}
              options={[
                { value: "apple", label: "Memorable" },
                { value: "random", label: "Random" },
              ]}
            />
          </fieldset>
          {mode === "random" ? (
            <label>
              <span className={label}>Length (optional)</span>
              <input
                className={inputClasses}
                type="number"
                min={8}
                value={length}
                onChange={(event) => setLength(event.target.value)}
              />
            </label>
          ) : null}
          <label>
            <span className={label}>Password rules (optional)</span>
            <input
              className={`${inputClasses} font-mono`}
              value={rules}
              autoComplete="off"
              spellCheck={false}
              placeholder="minlength: 12; required: lower, upper, digit;"
              onChange={(event) => setRules(event.target.value)}
            />
          </label>
          <ErrorNotice error={generate.error} />
        </fieldset>
        <Actions
          onCancel={onClose}
          busy={generate.isPending}
          submit={generate.isPending ? "Generating..." : "Generate"}
        />
      </form>
    </Dialog>
  );
}

export function DeleteCredential({
  credential,
  onClose,
  onDeleted,
}: {
  credential: Credential;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const remove = useCredentialMutation(() => api.deleteCredential(credential));
  return (
    <Dialog title="Delete credential" onClose={onClose} busy={remove.isPending}>
      <p className="mb-2">
        Delete <span className="font-semibold">{credential.name}</span> and all of its stored
        fields?
      </p>
      <p className="text-ink2">
        Agents lose access to its refs immediately. This cannot be undone.
      </p>
      <ErrorNotice error={remove.error} />
      <div className="mt-5 flex justify-end gap-2.5">
        <Button variant="quiet" disabled={remove.isPending} onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          className="border-line"
          disabled={remove.isPending}
          onClick={() => remove.mutate(undefined, { onSuccess: onDeleted })}
        >
          {remove.isPending ? "Deleting..." : "Delete credential"}
        </Button>
      </div>
    </Dialog>
  );
}

export function CreateCredential({
  defaultInbox,
  onClose,
  onCreated,
}: {
  defaultInbox: string;
  onClose: () => void;
  onCreated: (credential: Credential) => void;
}) {
  const inboxes = useQuery(inboxesQuery);
  const [inbox, setInbox] = useState(defaultInbox);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [mode, setMode] = useState<"generate" | "enter">("generate");
  const [fields, setFields] = useState<readonly AddedField[]>([
    { id: 1, name: "password", value: "" },
  ]);
  const selected = inbox || inboxes.data?.[0]?.inbox_id || "";
  const create = useCredentialMutation(() =>
    api.createCredential(selected, buildCreate({ name, url, username, mode, fields })),
  );
  const entered = fields.filter((field) => field.name.trim() !== "" && field.value !== "");
  const invalid =
    selected === "" ||
    name.trim() === "" ||
    (mode === "enter" && (entered.length === 0 || invalidFieldNames(fields).length > 0));
  return (
    <Dialog title="New credential" onClose={onClose} busy={create.isPending}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!invalid && !create.isPending) create.mutate(undefined, { onSuccess: onCreated });
        }}
        aria-busy={create.isPending}
      >
        <fieldset disabled={create.isPending} className="grid gap-4">
          {inboxes.data && inboxes.data.length > 0 ? (
            <Select
              label="Inbox"
              labelClassName="font-semibold"
              value={selected}
              onChange={setInbox}
              options={inboxes.data.map((item) => ({
                value: item.inbox_id,
                label: item.inbox_id,
              }))}
            />
          ) : (
            <p role="status" className="text-ink2">
              {inboxes.isPending ? "Loading inboxes..." : "Create an inbox first."}
            </p>
          )}
          <label>
            <span className={label}>Name</span>
            <input
              autoFocus
              className={inputClasses}
              value={name}
              maxLength={200}
              autoComplete="off"
              placeholder="Example account"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            <span className={label}>URL (optional)</span>
            <input
              className={inputClasses}
              type="url"
              value={url}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://example.com/login"
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <label>
            <span className={label}>Username (optional)</span>
            <input
              className={inputClasses}
              value={username}
              maxLength={320}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <fieldset className="min-w-0">
            <legend className={label}>Secret</legend>
            <Segmented<"generate" | "enter">
              name="create-mode"
              value={mode}
              onChange={setMode}
              options={[
                { value: "generate", label: "Generate a password" },
                { value: "enter", label: "Enter fields" },
              ]}
            />
            {mode === "enter" ? (
              <div className="mt-3">
                <AddedFields label="Field" fields={fields} onChange={setFields} />
              </div>
            ) : null}
          </fieldset>
          <ErrorNotice error={create.error} />
        </fieldset>
        <Actions
          onCancel={onClose}
          busy={create.isPending}
          submit={create.isPending ? "Creating..." : "Create credential"}
          disabled={invalid}
        />
      </form>
    </Dialog>
  );
}
