import { customAlphabet } from 'nanoid';

const generateSlug = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 6);

export function newDeploymentId(): string {
  return `dep-${generateSlug()}`;
}
