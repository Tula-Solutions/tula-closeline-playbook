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
