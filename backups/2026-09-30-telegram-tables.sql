--
-- PostgreSQL database dump
--

\restrict YSm7TF64RUgBMrgX04aZf9KGOPGdfq2VlsI1r1gbhcBqwkfyXuIn8UzwpwSfEck

-- Dumped from database version 18.0
-- Dumped by pg_dump version 18.0

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: telegram_attachments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.telegram_attachments (
    id bigint NOT NULL,
    message_id uuid NOT NULL,
    file_id text NOT NULL,
    mime text DEFAULT 'image/jpeg'::text NOT NULL,
    caption text
);


ALTER TABLE public.telegram_attachments OWNER TO postgres;

--
-- Name: telegram_attachments_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.telegram_attachments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.telegram_attachments_id_seq OWNER TO postgres;

--
-- Name: telegram_attachments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.telegram_attachments_id_seq OWNED BY public.telegram_attachments.id;


--
-- Name: telegram_deliveries; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.telegram_deliveries (
    message_id uuid NOT NULL,
    chat_id bigint NOT NULL,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    telegram_message_id bigint,
    attempts smallint DEFAULT 0 NOT NULL,
    last_error text,
    CONSTRAINT telegram_deliveries_attempts CHECK (((attempts >= 0) AND (attempts <= 5)))
);


ALTER TABLE public.telegram_deliveries OWNER TO postgres;

--
-- Name: telegram_link_codes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.telegram_link_codes (
    code text NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    CONSTRAINT telegram_link_codes_fmt CHECK ((code ~ '^[A-Z0-9]{6}$'::text))
);


ALTER TABLE public.telegram_link_codes OWNER TO postgres;

--
-- Name: telegram_links; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.telegram_links (
    chat_id bigint NOT NULL,
    user_id uuid NOT NULL,
    current_driver_id text,
    linked_at timestamp with time zone DEFAULT now() NOT NULL,
    linked_by_tg_user bigint NOT NULL
);


ALTER TABLE public.telegram_links OWNER TO postgres;

--
-- Name: telegram_attachments id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.telegram_attachments ALTER COLUMN id SET DEFAULT nextval('public.telegram_attachments_id_seq'::regclass);


--
-- Data for Name: telegram_attachments; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.telegram_attachments (id, message_id, file_id, mime, caption) FROM stdin;
\.


--
-- Data for Name: telegram_deliveries; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.telegram_deliveries (message_id, chat_id, claimed_at, sent_at, telegram_message_id, attempts, last_error) FROM stdin;
\.


--
-- Data for Name: telegram_link_codes; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.telegram_link_codes (code, user_id, created_at, expires_at, used_at) FROM stdin;
\.


--
-- Data for Name: telegram_links; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.telegram_links (chat_id, user_id, current_driver_id, linked_at, linked_by_tg_user) FROM stdin;
\.


--
-- Name: telegram_attachments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.telegram_attachments_id_seq', 18, true);


--
-- Name: telegram_attachments telegram_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.telegram_attachments
    ADD CONSTRAINT telegram_attachments_pkey PRIMARY KEY (id);


--
-- Name: telegram_deliveries telegram_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.telegram_deliveries
    ADD CONSTRAINT telegram_deliveries_pkey PRIMARY KEY (message_id);


--
-- Name: telegram_link_codes telegram_link_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.telegram_link_codes
    ADD CONSTRAINT telegram_link_codes_pkey PRIMARY KEY (code);


--
-- Name: telegram_links telegram_links_one_per_user; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.telegram_links
    ADD CONSTRAINT telegram_links_one_per_user UNIQUE (user_id);


--
-- Name: telegram_links telegram_links_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.telegram_links
    ADD CONSTRAINT telegram_links_pkey PRIMARY KEY (chat_id);


--
-- Name: idx_telegram_attachments_message; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_telegram_attachments_message ON public.telegram_attachments USING btree (message_id);


--
-- Name: idx_telegram_deliveries_pending; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_telegram_deliveries_pending ON public.telegram_deliveries USING btree (claimed_at) WHERE (sent_at IS NULL);


--
-- Name: idx_telegram_deliveries_tg; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_telegram_deliveries_tg ON public.telegram_deliveries USING btree (chat_id, telegram_message_id);


--
-- Name: telegram_attachments telegram_attachments_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.telegram_attachments
    ADD CONSTRAINT telegram_attachments_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.driver_messages(id) ON DELETE CASCADE;


--
-- Name: telegram_deliveries telegram_deliveries_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.telegram_deliveries
    ADD CONSTRAINT telegram_deliveries_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.driver_messages(id) ON DELETE CASCADE;


--
-- Name: telegram_link_codes telegram_link_codes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.telegram_link_codes
    ADD CONSTRAINT telegram_link_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: telegram_links telegram_links_current_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.telegram_links
    ADD CONSTRAINT telegram_links_current_driver_id_fkey FOREIGN KEY (current_driver_id) REFERENCES public.drivers(id) ON DELETE SET NULL;


--
-- Name: telegram_links telegram_links_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.telegram_links
    ADD CONSTRAINT telegram_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict YSm7TF64RUgBMrgX04aZf9KGOPGdfq2VlsI1r1gbhcBqwkfyXuIn8UzwpwSfEck

