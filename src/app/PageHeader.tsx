import type { ReactNode } from 'react';
import { Icon } from './icons';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  onBack: () => void;
  right?: ReactNode;
}

/** Шапка обычного экрана: назад, название и необязательное действие справа. */
export function PageHeader({ title, subtitle, onBack, right }: PageHeaderProps) {
  return (
    <header className="hw-pagehead">
      <button type="button" className="hw-iconbtn" onClick={onBack} aria-label="Назад">
        <Icon name="back" size={22} />
      </button>
      <div className="hw-pagehead-text">
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {right ?? null}
    </header>
  );
}
