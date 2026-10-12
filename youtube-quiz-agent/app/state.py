from app.models.schemas import ContentStatus

TRANSITIONS = {
    ContentStatus.IDEA: {ContentStatus.QUESTION_DRAFTED, ContentStatus.REJECTED, ContentStatus.FAILED},
    ContentStatus.QUESTION_DRAFTED: {ContentStatus.FACT_CHECK_PENDING, ContentStatus.REJECTED, ContentStatus.FAILED},
    ContentStatus.FACT_CHECK_PENDING: {ContentStatus.FACT_CHECKED, ContentStatus.QUESTION_DRAFTED, ContentStatus.REJECTED, ContentStatus.FAILED},
    ContentStatus.FACT_CHECKED: {ContentStatus.SCRIPT_CREATED, ContentStatus.FAILED},
    ContentStatus.SCRIPT_CREATED: {ContentStatus.VOICE_CREATED, ContentStatus.FAILED},
    ContentStatus.VOICE_CREATED: {ContentStatus.RENDERED, ContentStatus.FAILED},
    ContentStatus.RENDERED: {ContentStatus.QA_PENDING, ContentStatus.FAILED},
    ContentStatus.QA_PENDING: {ContentStatus.QA_PASSED, ContentStatus.RENDERED, ContentStatus.FAILED},
    ContentStatus.QA_PASSED: {ContentStatus.AWAITING_APPROVAL, ContentStatus.APPROVED},
    ContentStatus.AWAITING_APPROVAL: {ContentStatus.APPROVED, ContentStatus.REJECTED},
    ContentStatus.APPROVED: {ContentStatus.SCHEDULED, ContentStatus.REJECTED, ContentStatus.FAILED},
    ContentStatus.SCHEDULED: {ContentStatus.PUBLISHED, ContentStatus.REJECTED, ContentStatus.FAILED},
    ContentStatus.PUBLISHED: {ContentStatus.MEASURED, ContentStatus.FAILED},
}


def can_transition(source: ContentStatus, target: ContentStatus) -> bool:
    return target in TRANSITIONS.get(source, set())
