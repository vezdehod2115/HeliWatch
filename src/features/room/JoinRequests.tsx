import { Icon } from '../../app/icons';
import type { JoinRequestInfo } from '../../net/room';

interface JoinRequestsProps {
  requests: JoinRequestInfo[];
  onAccept: (userId: string) => void;
  onDeny: (userId: string) => void;
}

/** «Стук»: хост видит, кто просится, и решает — впустить или отклонить. */
export function JoinRequests({ requests, onAccept, onDeny }: JoinRequestsProps) {
  if (requests.length === 0) {
    return null;
  }
  return (
    <div className="hw-joinrequests" role="status" aria-live="polite">
      {requests.map((request) => (
        <div key={request.userId} className="hw-joinrequest">
          <span className="hw-member-dot" style={{ background: request.color }} />
          <div className="hw-joinrequest-main">
            <strong>{request.name}</strong>
            <span>просится в комнату</span>
          </div>
          <button
            type="button"
            className="hw-primary hw-primary--compact"
            onClick={() => onAccept(request.userId)}
          >
            Впустить
          </button>
          <button
            type="button"
            className="hw-ghost"
            onClick={() => onDeny(request.userId)}
            aria-label={`Отклонить вход ${request.name}`}
          >
            <Icon name="close" size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}
