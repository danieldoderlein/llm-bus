// Billing notifications - INERT in the open-source build.
//
// The commercial build emails the person who can actually pay (decision 067). With billing disabled
// there is nothing to notify about, so these are no-ops that keep the call sites compiling and the
// seam honest. `EmailSender` is exported because the invite/admin paths type against it.
export interface EmailSender {
  (to: string, subject: string, body: string, opts?: Record<string, unknown>): Promise<void>;
}

export const logEmail: EmailSender = async (to, subject) => {
  console.log(`[llm-bus] email (not sent - OSS build): ${to} / ${subject}`);
};

export const configuredEmail: EmailSender = logEmail;

export async function notifyInvite(..._args: unknown[]): Promise<void> {
  return;
}

export async function notifyFunding(..._args: unknown[]): Promise<void> {
  return;
}
