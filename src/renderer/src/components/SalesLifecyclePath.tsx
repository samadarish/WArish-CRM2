import { useMemo, useState, type CSSProperties } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, CircleAlert, LoaderCircle, RefreshCw } from 'lucide-react'
import type { ChatSummary, CrmContactDetailsDto, CrmStageDto } from '../../../shared/contracts'
import { useUiStore } from '../store'
import { Tooltip } from './ui-primitives'

export function SalesLifecyclePath({ chat }: { chat: ChatSummary }): React.JSX.Element {
  const queryClient = useQueryClient()
  const pushNotice = useUiStore((state) => state.pushNotice)
  const [optimisticStage, setOptimisticStage] = useState<{ chatId: string; stageId: string }>()
  const stagesQuery = useQuery({
    queryKey: ['crm', 'pipeline'],
    queryFn: () => window.warish.crm.pipeline(),
    staleTime: 5 * 60_000
  })
  const stages = useMemo(() => [...(stagesQuery.data ?? [])].sort((left, right) => left.position - right.position), [stagesQuery.data])
  const optimisticStageId = optimisticStage?.chatId === chat.id && optimisticStage.stageId !== chat.crm?.stageId
    ? optimisticStage.stageId : undefined
  const activeStageId = optimisticStageId ?? chat.crm?.stageId
  const activeIndex = stages.findIndex((stage) => stage.id === activeStageId)

  const stageMutation = useMutation({
    mutationFn: async (stage: CrmStageDto) => {
      if (chat.crm?.contactId) return window.warish.crm.contacts.setStage(chat.crm.contactId, stage.id)
      const contact: CrmContactDetailsDto = await window.warish.crm.contacts.ensure(chat.id)
      queryClient.setQueryData(['crm', 'contact', contact.id], contact)
      queryClient.setQueryData(['crm', 'contact', 'chat', chat.id], contact)
      return contact.stageId === stage.id ? contact : window.warish.crm.contacts.setStage(contact.id, stage.id)
    },
    onMutate: (stage) => setOptimisticStage({ chatId: chat.id, stageId: stage.id }),
    onSuccess: async (contact) => {
      queryClient.setQueryData(['crm', 'contact', contact.id], contact)
      queryClient.setQueryData(['crm', 'contact', 'chat', chat.id], contact)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['chat', chat.id] }),
        queryClient.invalidateQueries({ queryKey: ['chats'] }),
        queryClient.invalidateQueries({ queryKey: ['crm', 'contacts'] }),
        queryClient.invalidateQueries({ queryKey: ['crm', 'dashboard'] })
      ])
      setOptimisticStage(undefined)
    },
    onError: (error) => {
      setOptimisticStage(undefined)
      pushNotice(error instanceof Error ? error.message : 'Could not update the sales stage')
    }
  })

  return <section className="sales-lifecycle" aria-label="Sales lifecycle">
    <span className="sales-lifecycle-label"><strong>Pipeline</strong><small>{chat.crm?.stageName ?? 'Not tracked'}</small></span>
    <div className="sales-lifecycle-scroll">
      {stagesQuery.isLoading && <div className="sales-lifecycle-skeleton" aria-label="Loading sales lifecycle">
        {Array.from({ length: 5 }, (_, index) => <i key={index} />)}
      </div>}
      {stagesQuery.isError && <div className="sales-lifecycle-error"><CircleAlert /><span>Lifecycle unavailable</span>
        <Tooltip label="Retry"><button aria-label="Retry loading sales lifecycle"
          onClick={() => void stagesQuery.refetch()}><RefreshCw /></button></Tooltip></div>}
      {!stagesQuery.isLoading && !stagesQuery.isError && stages.length === 0 && <div className="sales-lifecycle-error"><CircleAlert /><span>No pipeline stages</span></div>}
      {stages.length > 0 && <div className="sales-lifecycle-path" role="group" aria-label="Pipeline stages">{stages.map((stage, index) => {
        const current = stage.id === activeStageId
        const completed = activeIndex >= 0 && index < activeIndex && stage.outcome === 'open'
        const pending = stageMutation.isPending && stageMutation.variables?.id === stage.id
        return <button key={stage.id} className={`${current ? 'current' : ''} ${completed ? 'completed' : ''} outcome-${stage.outcome}`}
          style={{ '--stage-color': stage.color } as CSSProperties} aria-current={current ? 'step' : undefined}
          aria-label={`Set sales stage to ${stage.name}`} disabled={stageMutation.isPending}
          onClick={() => { if (!current || !chat.crm) stageMutation.mutate(stage) }}>
          <span className="sales-lifecycle-state">{pending ? <LoaderCircle className="spin" /> : completed ? <Check /> : null}</span>
          <span>{stage.name}</span>
        </button>
      })}</div>}
    </div>
  </section>
}
