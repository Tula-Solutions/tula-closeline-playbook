# Closeline

Closeline is a sales platform in which AI workers and human salespeople sell on behalf of a customer company, guided by what that company's past sales show to work.

## Language

**Organization**:
A customer company's isolated account, owning all of its people, knowledge and activity.
_Avoid_: Workspace, company, tenant, account, customer

**Region**:
The geography an Organization is created in and whose boundary its data never crosses.
_Avoid_: Data centre, cell, zone

**Owner**:
The member of an Organization who controls its billing and its deletion.

**Admin**:
A member who manages an Organization's people, Playbook, Agents and integrations, and can see every conversation in it.
_Avoid_: Administrator, superuser

**Manager**:
A member who can see the conversations of the Reps on their own Team.
_Avoid_: Supervisor, team lead

**Rep**:
A human salesperson who belongs to an Organization and can see only their own conversations.
_Avoid_: User, seller, salesperson, sales agent

**Team**:
A group of Reps inside an Organization, overseen by one or more Managers.
_Avoid_: Group, squad, department

**Membership**:
A person's place in one Organization, with the role they hold there.
_Avoid_: Seat, license

**Invitation**:
An offer, sent to an email address, to join an Organization in a stated role.
_Avoid_: Invite link, signup link

**Prospect**:
A person an Organization is trying to sell to.
_Avoid_: Lead, contact, customer, user

**Agent**:
An autonomous AI worker that sells for an Organization without a Rep taking part.
_Avoid_: Bot, digital worker, AI rep, assistant

**Inbound Agent**:
The Agent that responds to Prospects who make contact first, qualifying them and booking or handing them to a Rep.
_Avoid_: Phone agent, receptionist

**Outbound Agent**:
The Agent that starts contact with Prospects by running campaigns across channels.
_Avoid_: Email agent, SDR, sequencer

**Copilot**:
The live assistant that advises a Rep during a conversation with a Prospect.
_Avoid_: Coach, assistant, agent

**Playbook**:
An Organization's sales knowledge: the material it uploaded and what was derived from its past sales.
_Avoid_: Knowledge base, training data, brain

**Voice Profile**:
A cloned voice of a real person, created with that person's recorded consent and owned by one Organization.
_Avoid_: Voice clone, custom voice

**Contact Consent**:
A stored record that a Prospect agreed to be contacted by an Organization's Agent on one named channel.
_Avoid_: Calling consent, opt-in, permission

**Document**:
A file an Organization uploaded to its Playbook, such as a sales deck or product guide.
_Avoid_: Asset, knowledge article, attachment

**Call**:
A spoken exchange between a Prospect and a Rep or an Agent, live or uploaded from the Organization's past; not a text exchange.
_Avoid_: Meeting, session

**Recording**:
The audio file of a Call, kept by the Organization; not the announcement that a Call is recorded.
_Avoid_: Voice file, audio clip

**Transcript**:
The written turns of a Call, each attributed to one speaker.
_Avoid_: Call notes, script, captions

**Deal**:
A sale an Organization is pursuing or has closed with a Prospect, named by the Organization's own identifier.
_Avoid_: Opportunity, lead, order

**Outcome**:
Whether a Deal was won, lost or is still open.
_Avoid_: Result, disposition, status (of a Deal)

**Moment**:
A short window of consecutive turns in a Call, kept with its Deal's Outcome so search can find similar ones. A piece of a Document is a chunk, not a Moment.
_Avoid_: Snippet, segment, clip

**Linked Google account**:
A person's Google account tied to their Closeline sign-in, so they can sign in with Google as well as, or instead of, a password.
_Avoid_: Google login, social login, SSO

**Visitor**:
A person browsing Closeline's public site who has not signed in.
_Avoid_: User, lead, traffic

**Demo Request**:
A Visitor's submitted wish to see Closeline, held by Closeline itself and not by any Organization.
_Avoid_: Lead, enquiry, signup

**Prospect Company**:
The business a Prospect works for, held as a record in an Organization's book.
_Avoid_: Account, Organization (that is the Closeline customer), company, client

**Source**:
Where a value on a Prospect or Prospect Company came from, with the time it arrived: manual entry, an import, a CRM or an enrichment provider.
_Avoid_: Origin, provenance (in user-facing text)

**Suppression**:
An Organization's record that an address must not be contacted, made on a Prospect's request or by a bounce or complaint.
_Avoid_: Blocklist, DNC list, opt-out list

**Contact Check**:
The question every channel asks before contacting a Prospect, answered allowed or denied with a reason.
_Avoid_: Permission check, compliance check

**Consent Wording**:
The exact text a Prospect was shown when agreeing, kept unchanged.
_Avoid_: Disclaimer, consent terms

**CRM connection**:
An Organization's authorised link to one external customer-relationship system, from which Closeline reads and to which it can write.
_Avoid_: Integration (generic), sync account, plug-in

**Stage mapping**:
An Admin's rule saying which CRM deal stages mean won, lost or open.
_Avoid_: Pipeline mapping, status mapping
