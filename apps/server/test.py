from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ListNode:
    """Single node in a singly linked list."""

    value: int
    next: "ListNode | None" = None


def reverse_linked_list(head: ListNode | None) -> ListNode | None:
    """Reverse a linked list in place and return the new head."""

    prev = None
    current = head

    while current is not None:
        current.next, prev, current = prev, current, current.next

    return prev


def build_linked_list(values: list[int]) -> ListNode | None:
    """Build a linked list from Python list values."""

    head: ListNode | None = None

    for value in reversed(values):
        head = ListNode(value=value, next=head)

    return head


def linked_list_to_string(head: ListNode | None) -> str:
    """Return a readable arrow-separated representation of the list."""

    values: list[str] = []
    current = head

    while current is not None:
        values.append(str(current.value))
        current = current.next

    return " -> ".join(values) if values else "empty"


def say_hello() -> str:
    """Return a friendly greeting."""

    return "Hello"


def main() -> None:
    """Build, reverse, and print an example linked list."""

    original_values = [1, 2, 3]
    head = build_linked_list(original_values)
    reversed_head = reverse_linked_list(head)

    print(linked_list_to_string(reversed_head))


if __name__ == "__main__":
    main()
