create table if not exists public.treehole_messages (
  id uuid primary key,
  created_at timestamptz not null default now(),
  client_id text not null,
  author text not null,
  text text not null default '',
  media jsonb
);

create index if not exists treehole_messages_created_at_idx
  on public.treehole_messages (created_at desc);

alter table public.treehole_messages enable row level security;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'treehole-media',
  'treehole-media',
  false,
  52428800,
  array[
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'video/mp4',
    'video/webm',
    'video/quicktime'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
